// End-to-end check: real Vite dev server + real Chrome + real MCP client.
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = fileURLToPath(new URL('../demo', import.meta.url));
const server = await createServer({ root, configFile: `${root}/vite.config.js`, server: { port: 5199, strictPort: true }, logLevel: 'warn' });
await server.listen();
const base = 'http://localhost:5199';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'warning' && console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[page error]', e.message));

let failed = false;
try {
  await page.goto(base);
  await page.waitForSelector('li');

  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/__react-perf/mcp`)));
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;

  console.log((await client.listTools()).tools.map((t) => t.name).join(', '));

  await page.waitForTimeout(400);
  await call('react_rerender_clear');
  await page.type('#search', 'odo 1', { delay: 30 });
  await page.click('li >> nth=1');
  await page.waitForTimeout(600);

  const report = await call('react_rerender_report', { limit: 6 });
  console.log('\n===== react_rerender_report =====\n' + report);
  console.log('\n===== react_component_renders TodoItem =====\n' + (await call('react_component_renders', { name: 'TodoItem', limit: 3 })));
  console.log('\n===== react_commits =====\n' + (await call('react_commits', { limit: 4 })));
  console.log('\n===== react_rerender_status =====\n' + (await call('react_rerender_status')));

  const expectations = [
    ['TodoItem onToggle same-code function', /prop `onToggle` changed .*always same value/],
    ['TodoItem options same-value object', /prop `options` changed .*always same value/],
    ['context recreated with same value', /context ThemeContext changed .*always same value/],
    ['App state change (useState)', /state \(1st useState\) changed/],
    ['SlowStats parent-only cascade from App', /parent re-rendered, props unchanged \d+× \(cascade from App/],
    ['onToggle traced to App through TodoList', /`onToggle` changed .*created in App, passed down via TodoList\.onToggle/],
    ['useCallback hint points at App', /`onToggle` is a new function .*useCallback in App/],
    ['options created in TodoList', /`options` is a new object .*useMemo it in TodoList/],
    ['real change shows changed path', /\[\d+\]\.done: (true|false) → (true|false)/],
  ];
  for (const [label, re] of expectations) {
    const ok = re.test(report);
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  }

  // The agent reproduces the interaction itself, in its own headless browser.
  const scenario = await client.callTool({
    name: 'react_run_scenario',
    arguments: {
      steps: [
        { action: 'type', selector: '#search', text: 'odo 2' },
        { action: 'click', selector: 'li >> nth=0' },
        { action: 'click', selector: '#does-not-exist' },
      ],
      settleMs: 300,
      screenshot: true,
      limit: 3,
    },
  });
  const scenarioText = scenario.content[0].text;
  console.log('\n===== react_run_scenario =====\n' + scenarioText);
  const scenarioChecks = [
    ['scenario logs each step', /1\. type #search "odo 2" — \d+ms/.test(scenarioText)],
    ['scenario reports a failed step and stops', /3\. click #does-not-exist — FAILED/.test(scenarioText)],
    ['scenario report excludes initial mount', /\(0 mounts/.test(scenarioText) && !/\(\d*[1-9]\d* mounts/.test(scenarioText)],
    ['scenario report finds the onToggle problem', /`onToggle` is a new function .*useCallback in App/.test(scenarioText)],
    ['scenario only counts its own tab (5 keystrokes + 1 click)', /, 6 commits,/.test(scenarioText)],
    ['scenario returns a screenshot', scenario.content[1]?.type === 'image' && scenario.content[1].data.length > 1000],
  ];
  for (const [label, ok] of scenarioChecks) {
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  }

  // Record → save → replay → compare: the user just uses the app; the agent turns it into a scenario.
  await page.reload();
  await page.waitForSelector('li');
  await page.waitForTimeout(400);
  await call('react_rerender_clear');
  await page.click('#search');
  await page.keyboard.type('odo 3', { delay: 50 });
  await page.waitForTimeout(1300);
  await page.click('li >> nth=0');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1300);

  const recorded = await call('react_recorded_actions');
  console.log('\n===== react_recorded_actions =====\n' + recorded);
  const saved = await call('react_save_scenario', { name: 'e2e-toggle', description: 'Search todos, toggle one' });
  console.log('\n===== react_save_scenario =====\n' + saved);
  const run1 = await call('react_run_scenario', { name: 'e2e-toggle', limit: 2 });
  const run2 = await call('react_run_scenario', { name: 'e2e-toggle', limit: 2 });
  console.log('\n===== react_run_scenario (2nd run, head) =====\n' + run2.split('\n').slice(0, 22).join('\n'));
  const fallback = await call('react_run_scenario', {
    steps: [{ action: 'click', selector: '#gone', fallbackSelectors: ['li >> nth=2'] }],
    settleMs: 200,
    limit: 1,
  });
  const list = await call('react_list_scenarios');

  const loopChecks = [
    ['recorder captures typing as one step', /type #search "odo 3" — \d+ commits/.test(recorded)],
    ['recorder captures the click with a text selector', /click li:has-text\("#3 Todo 3/.test(recorded)],
    ['recorder captures key presses', /press Escape/.test(recorded)],
    ['recorder shows React cost per action', /type #search "odo 3" — 5 commits/.test(recorded)],
    ['saved scenario includes the pause as a wait', /wait 1\d00ms/.test(saved)],
    ['first run is the baseline and fails default budgets', /FAIL ✗/.test(run1) && /First recorded run/.test(run1) && /Budgets \(defaults/.test(run1)],
    ['replay reproduces the same renders', /, 6 commits,/.test(run1)],
    ['second run compares with the first', /Compared with previous run/.test(run2) && /= avoidable renders: \d+ → \d+/.test(run2)],
    ['fallback selector is used when the primary is missing', /fallback selector li >> nth=2/.test(fallback)],
    ['list shows the last result', /e2e-toggle: Search todos, toggle one — \d+ steps from \/; last run FAIL/.test(list)],
  ];
  for (const [label, ok] of loopChecks) {
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  }
  await rm(`${root}/perf`, { recursive: true, force: true });
  await client.close();
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
