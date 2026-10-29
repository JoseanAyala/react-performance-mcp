// Runs a scripted interaction in a headless browser against the dev server and returns the
// re-render report for exactly that run. Uses playwright-core with an installed Chrome/Edge
// (or Playwright's own Chromium if present), so no browser download is needed.

import { DEFAULT_BUDGETS, checkBudgets, compareMetrics, describeStep } from './scenario-files.js';
import { formatCommits, formatReport, metrics as computeMetrics } from './store.js';

const STEP_TIMEOUT = 5_000;
const FALLBACK_TIMEOUT = 1_500;

let browserPromise = null;
let running = null;

export async function runScenario(store, options, input) {
  if (running) throw new Error('Another scenario is still running; try again when it finishes.');
  running = runAll(store, options, input);
  try {
    return await running;
  } finally {
    running = null;
  }
}

async function runAll(store, options, input) {
  const files = options.scenarioFiles;
  const saved = input.name ? await files.load(input.name) : null;
  if (!saved && !input.steps?.length) throw new Error('Pass `steps`, or `name` of a saved scenario.');

  const scenario = {
    path: input.path ?? saved?.path ?? '/',
    viewport: saved?.viewport ?? null,
    steps: input.steps ?? saved.steps,
    cpuThrottle: input.cpuThrottle ?? saved?.cpuThrottle ?? 1,
    settleMs: input.settleMs ?? 500,
  };
  const runs = Math.max(1, input.runs ?? saved?.runs ?? 1);

  // Several runs smooth out timing noise: report the median run (by total commit time).
  const results = [];
  for (let i = 0; i < runs; i++) results.push(await runOnce(store, options, scenario, input));
  const sortedRuns = [...results].sort((a, b) => a.metrics.totalCommitMs - b.metrics.totalCommitMs);
  const result = sortedRuns[Math.floor((sortedRuns.length - 1) / 2)];

  const sections = [];
  if (saved) {
    const budgets = saved.budgets ?? DEFAULT_BUDGETS;
    const checks = checkBudgets(result.metrics, budgets);
    const passed = checks.every((c) => c.ok) && !result.failedStep;
    const history = await files.history(saved.name);
    const previous = history.at(-1);
    sections.push(
      `Scenario "${saved.name}" — ${passed ? 'PASS ✓' : 'FAIL ✗'}` +
        (result.failedStep ? ' (a step failed; fix the selector or the app before trusting these numbers)' : ''),
      `Budgets${saved.budgets ? '' : ' (defaults — set your own with react_save_scenario)'}:`,
      ...checks.map((c) => `  ${c.ok ? '✓' : '✗'} ${c.label}: ${c.actual} ${c.ok ? '≤' : '>'} ${c.limit}`),
    );
    if (previous) {
      sections.push(`Compared with previous run (${ago(previous.at)}):`, ...compareMetrics(previous.metrics, result.metrics).map((l) => `  ${l}`));
    } else {
      sections.push('First recorded run — this is the baseline for the next comparison.');
    }
    await files.addResult(saved.name, { at: Date.now(), passed, runs, metrics: result.metrics });
    sections.push('');
  }

  sections.push(
    `Run on ${result.url}${runs > 1 ? ` (median of ${runs} runs)` : ''}${scenario.cpuThrottle > 1 ? `, CPU throttled ${scenario.cpuThrottle}×` : ''}`,
    ...result.log.map((l) => `  ${l}`),
  );
  if (result.errors.length) sections.push('', 'Page errors:', ...result.errors.slice(0, 10).map((e) => `  ${e}`));
  sections.push('', formatReport(result.commits, { sort: input.sort, limit: input.limit }), '', formatCommits(result.commits, 15));

  const content = [{ type: 'text', text: sections.join('\n') }];
  if (result.screenshot) content.push({ type: 'image', data: result.screenshot, mimeType: 'image/png' });
  return content;
}

async function runOnce(store, options, scenario, input) {
  const baseUrl = options.getBaseUrl();
  if (!baseUrl) throw new Error('The dev server is not listening yet.');
  const browser = await getBrowser(options);
  const viewport = scenario.viewport ?? { width: 1400, height: 900 };
  const context = await browser.newContext({ viewport, ...(options.scenario?.contextOptions ?? {}) });
  await context.addInitScript(() => {
    window.__REACT_PERF_MCP_REPLAY__ = true;
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon\.ico/.test(m.location()?.url ?? '')) errors.push(m.text());
  });

  const url = new URL(scenario.path, baseUrl).href;
  const log = [];
  let tab = null;
  let failedStep = null;
  try {
    if (scenario.cpuThrottle > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: scenario.cpuThrottle });
    }
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'load' });
    tab = await page
      .waitForFunction(() => window.__REACT_PERF_MCP__?.tabId, null, { timeout: STEP_TIMEOUT })
      .then((h) => h.jsonValue());
    await page.waitForTimeout(scenario.settleMs);
    log.push(`load ${scenario.path} — ${Date.now() - t0}ms`);

    const start = input.includeLoad ? 0 : await page.evaluate(() => Date.now());
    for (const [i, step] of scenario.steps.entries()) {
      const before = Date.now();
      try {
        const used = await perform(page, baseUrl, step);
        const note = used && used !== step.selector ? ` (fallback selector ${used})` : '';
        log.push(`${i + 1}. ${describeStep(step)} — ${Date.now() - before}ms${note}`);
      } catch (error) {
        failedStep = i + 1;
        log.push(`${i + 1}. ${describeStep(step)} — FAILED: ${String(error.message).split('\n')[0]}`);
        break;
      }
    }

    await page.waitForTimeout(scenario.settleMs);
    await page.evaluate(() => window.__REACT_PERF_MCP__?.flush()).catch(() => {});

    const commits = store.select({ tab, from: start });
    const screenshot = input.screenshot ? (await page.screenshot({ type: 'png' })).toString('base64') : null;
    return { url, log, errors, commits, metrics: computeMetrics(commits), failedStep, screenshot };
  } finally {
    await context.close().catch(() => {});
    if (tab) store.forget(tab);
  }
}

// Returns the selector that was actually used (recorded steps carry fallbacks for when data changed).
async function perform(page, baseUrl, step) {
  const timeout = STEP_TIMEOUT;
  const need = (field) => {
    if (step[field] === undefined) throw new Error(`"${step.action}" needs "${field}"`);
    return step[field];
  };
  const target = step.selector ? await resolveSelector(page, step) : null;
  const selector = () => need('selector') && target;
  const clickOptions = {
    timeout,
    ...(step.button && { button: step.button }),
    ...(step.modifiers && { modifiers: step.modifiers }),
    ...(step.position && { position: step.position }),
    ...(step.delay && { delay: step.delay }),
  };
  const times = Math.max(1, step.repeat ?? 1);
  for (let n = 0; n < times; n++) {
    switch (step.action) {
      case 'goto':
        await page.goto(new URL(need('url'), baseUrl).href, { waitUntil: 'load' });
        break;
      case 'reload':
        await page.reload({ waitUntil: 'load' });
        break;
      case 'back':
        await page.goBack({ waitUntil: 'load' });
        break;
      case 'forward':
        await page.goForward({ waitUntil: 'load' });
        break;
      case 'click':
      case 'dblclick':
        if (!step.selector && step.position) await clickAt(page, step);
        else if (step.action === 'click') await page.click(selector(), clickOptions);
        else await page.dblclick(selector(), clickOptions);
        break;
      case 'hover':
        await page.hover(selector(), { timeout, ...(step.position && { position: step.position }) });
        break;
      case 'move': {
        const box = await boxOf(page, selector());
        const points = need('points');
        const pause = Math.min(100, (step.duration ?? 0) / Math.max(1, points.length));
        for (const [x, y] of points) {
          await page.mouse.move(box.x + x, box.y + y);
          if (pause) await page.waitForTimeout(pause);
        }
        break;
      }
      case 'drag': {
        const box = await boxOf(page, selector());
        const from = step.from ?? { x: box.width / 2, y: box.height / 2 };
        const x0 = box.x + from.x;
        const y0 = box.y + from.y;
        const points = need('points');
        const pause = Math.min(100, (step.duration ?? 0) / Math.max(1, points.length));
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (const [dx, dy] of points) {
          await page.mouse.move(x0 + dx, y0 + dy, { steps: 2 });
          if (pause) await page.waitForTimeout(pause);
        }
        await page.mouse.up();
        break;
      }
      case 'dragTo':
        await page.dragAndDrop(selector(), need('to'), { timeout });
        break;
      case 'fill':
        await page.fill(selector(), step.text ?? '', { timeout });
        break;
      case 'type':
        // Key by key, like a real user, so every keystroke's render is captured.
        if (target) {
          await page.locator(target).focus({ timeout });
          await page.locator(target).evaluate(placeCaret, -1);
        }
        await page.keyboard.type(need('text'), { delay: 40 });
        break;
      case 'caret':
        await page.locator(selector()).focus({ timeout });
        await page.locator(target).evaluate(placeCaret, step.offset ?? -1);
        break;
      case 'insertText':
        await page.keyboard.insertText(need('text'));
        break;
      case 'press':
        if (target) await page.press(target, need('key'), { timeout });
        else await page.keyboard.press(need('key'));
        break;
      case 'select':
        await page.selectOption(selector(), step.values ?? need('value'), { timeout });
        break;
      case 'check':
        await page.check(selector(), { timeout });
        break;
      case 'uncheck':
        await page.uncheck(selector(), { timeout });
        break;
      case 'upload':
        await page.setInputFiles(selector(), need('files').map(placeholderFile), { timeout });
        break;
      case 'dropFiles':
        await page.locator(selector()).evaluate(dropFiles, need('files').map((f) => ({ name: f.name, type: f.type, size: placeholderSize(f) })));
        break;
      case 'scroll':
        if (target) await page.locator(target).evaluate((el, d) => el.scrollBy(d.x, d.y), { x: step.x ?? 0, y: step.y ?? 600 });
        else await page.evaluate((d) => window.scrollBy(d.x, d.y), { x: step.x ?? 0, y: step.y ?? 600 });
        await page.waitForTimeout(100);
        break;
      case 'wheel': {
        const box = await boxOf(page, selector());
        const at = step.position ?? { x: box.width / 2, y: box.height / 2 };
        await page.mouse.move(box.x + at.x, box.y + at.y);
        for (const m of step.modifiers ?? []) await page.keyboard.down(m);
        await page.mouse.wheel(step.dx ?? 0, step.dy ?? 0);
        for (const m of step.modifiers ?? []) await page.keyboard.up(m);
        await page.waitForTimeout(100);
        break;
      }
      case 'resize':
        await page.setViewportSize({ width: need('width'), height: need('height') });
        await page.waitForTimeout(100);
        break;
      case 'wait':
        await page.waitForTimeout(Math.min(step.ms ?? 500, 30_000));
        break;
      case 'waitFor':
        await page.waitForSelector(selector(), { timeout });
        break;
      default:
        throw new Error(`Unknown action "${step.action}"`);
    }
  }
  return target;
}

// Clicks recorded on the page background: viewport coordinates, no element.
async function clickAt(page, step) {
  for (const m of step.modifiers ?? []) await page.keyboard.down(m);
  await page.mouse.click(step.position.x, step.position.y, {
    button: step.button ?? 'left',
    clickCount: step.action === 'dblclick' ? 2 : 1,
    ...(step.delay && { delay: step.delay }),
  });
  for (const m of step.modifiers ?? []) await page.keyboard.up(m);
}

async function boxOf(page, selector) {
  const locator = page.locator(selector);
  await locator.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT });
  const box = await locator.boundingBox({ timeout: STEP_TIMEOUT });
  if (!box) throw new Error(`${selector} is not visible`);
  return box;
}

const MAX_PLACEHOLDER_BYTES = 5 * 1024 * 1024;

function placeholderSize(file) {
  return Math.min(file.size ?? 0, MAX_PLACEHOLDER_BYTES);
}

function placeholderFile(file) {
  return { name: file.name, mimeType: file.type || 'application/octet-stream', buffer: Buffer.alloc(placeholderSize(file)) };
}

// Runs in the page: caret at a text offset (-1 = end) in an input, textarea or contenteditable.
function placeCaret(el, offset) {
  if ('selectionStart' in el && typeof el.value === 'string') {
    const at = offset < 0 ? el.value.length : Math.min(offset, el.value.length);
    try {
      el.setSelectionRange(at, at);
    } catch {
      // number/email inputs don't support selection ranges
    }
    return;
  }
  const selection = getSelection();
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = null;
  let last = null;
  while ((node = walker.nextNode())) {
    last = node;
    if (offset >= 0 && remaining <= node.length) break;
    remaining -= node.length;
  }
  if (offset >= 0 && node) range.setStart(node, remaining);
  else if (last) range.setStart(last, last.length);
  else range.selectNodeContents(el);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

// Runs in the page: dispatches a file drop with placeholder files of the recorded names and sizes.
function dropFiles(el, files) {
  const data = new DataTransfer();
  for (const f of files) data.items.add(new File([new Uint8Array(f.size)], f.name, { type: f.type || '' }));
  for (const type of ['dragenter', 'dragover', 'drop']) {
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: data }));
  }
}

async function resolveSelector(page, step) {
  const candidates = [step.selector, ...(step.fallbackSelectors ?? [])];
  if (candidates.length === 1) return step.selector;
  for (const [i, selector] of candidates.entries()) {
    const locator = page.locator(selector);
    try {
      await locator.first().waitFor({ state: 'attached', timeout: i === 0 ? FALLBACK_TIMEOUT : 500 });
      if ((await locator.count()) === 1) return selector;
    } catch {
      // try the next candidate
    }
  }
  return step.selector; // let the action fail with Playwright's own error message
}

function ago(at) {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

async function getBrowser(options) {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    if (browser?.isConnected()) return browser;
  }
  browserPromise = launch(options);
  return browserPromise;
}

async function launch(options) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('react_run_scenario needs playwright-core: npm install -D playwright-core');
  }
  const config = options.scenario ?? {};
  const headless = config.headless ?? true;
  if (config.executablePath) return chromium.launch({ executablePath: config.executablePath, headless });
  const attempts = config.channel ? [config.channel] : ['chrome', 'msedge', undefined];
  const failures = [];
  for (const channel of attempts) {
    try {
      return await chromium.launch({ channel, headless });
    } catch (error) {
      failures.push(`${channel ?? 'playwright chromium'}: ${String(error.message).split('\n')[0]}`);
    }
  }
  throw new Error(
    'Could not launch a browser. Install Google Chrome, or run `npx playwright install chromium`, ' +
      'or pass reactPerformanceMcp({ scenario: { executablePath } }).\n' + failures.join('\n'),
  );
}

export async function closeScenarioBrowser() {
  const browser = await browserPromise?.catch(() => null);
  browserPromise = null;
  await browser?.close().catch(() => {});
}
