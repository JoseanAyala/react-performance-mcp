// Record every kind of interaction as a "user" (real, trusted browser input), then replay the
// saved scenario through the MCP and check the app ends in exactly the same state.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = fileURLToPath(new URL('./lab', import.meta.url));
const server = await createServer({ root, configFile: `${root}/vite.config.js`, server: { port: 5198, strictPort: true }, logLevel: 'warn' });
await server.listen();
const base = 'http://localhost:5198';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const client = new Client({ name: 'interactions', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/__react-perf/mcp`)));
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return result.content[0].text;
};

let failed = false;
const check = (label, ok) => {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
};
const pause = (page, ms = 250) => page.waitForTimeout(ms);
const center = async (page, selector) => {
  const b = await page.locator(selector).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const stateOf = (page) => page.locator('#state').textContent();

async function replayMatches(name, expected) {
  const file = `${root}/perf/scenarios/${name}.json`;
  const scenario = JSON.parse(await readFile(file, 'utf8'));
  scenario.steps.push({ action: 'waitFor', selector: `output#state:has-text(${JSON.stringify(expected)})` });
  await writeFile(file, JSON.stringify(scenario, null, 2));
  const result = await client.callTool({ name: 'react_run_scenario', arguments: { name, limit: 3, screenshot: true } });
  const text = result.content[0].text;
  if (/FAILED/.test(text) && process.env.FAILED_SHOT && result.content[1]) {
    await writeFile(`${process.env.FAILED_SHOT}-${name}.png`, Buffer.from(result.content[1].data, 'base64'));
  }
  return text;
}

try {
  // ---- Part A: every single-page interaction
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector('#state');
  await pause(page, 500);
  await call('react_rerender_clear');

  await page.hover('#menu'); // hover with a React onMouseEnter
  await pause(page);
  const chart = await page.locator('#chart').boundingBox(); // mouse-tracking chart
  for (let x = 10; x <= 200; x += 19) {
    await page.mouse.move(chart.x + x, chart.y + 30);
    await pause(page, 30);
  }
  await page.mouse.move(chart.x + 150, chart.y + 200);
  await pause(page);
  const rowA = await center(page, '[data-testid=row-a]'); // pointer-drag sortable list
  await page.mouse.move(rowA.x, rowA.y);
  await page.mouse.down();
  for (let dy = 10; dy <= 65; dy += 11) await page.mouse.move(rowA.x, rowA.y + dy);
  await page.mouse.up();
  await pause(page);
  await page.dragAndDrop('#card-x', '#zone'); // HTML5 drag and drop
  await pause(page);
  await page.click('#text'); // mid-text edit in an input
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type(' big', { delay: 40 });
  await pause(page, 1200);
  await page.click('#editor'); // contenteditable editor
  await page.keyboard.type('Hi there', { delay: 40 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await pause(page, 1200);
  await page.click('#ctx', { button: 'right' }); // right and middle click
  await page.click('#ctx', { button: 'middle' });
  await pause(page);
  await page.hover('#zoomable'); // ctrl+wheel zoom
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await pause(page, 500);
  await page.hover('#scroller'); // wheel-scrolling a container
  await page.mouse.wheel(0, 300);
  await pause(page, 500);
  const hold = await center(page, '#hold'); // long press
  await page.mouse.move(hold.x, hold.y);
  await page.mouse.down();
  await pause(page, 700);
  await page.mouse.up();
  await pause(page);
  await page.click('lab-widget >> button'); // shadow DOM
  await pause(page);
  await page.click('#tab-b'); // SPA navigation + browser back button
  await pause(page, 600);
  await page.goBack();
  await pause(page, 400);
  await page.setInputFiles('#file', [{ name: 'report.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') }]); // file input
  await pause(page);
  await page.selectOption('#color', 'blue'); // <select>
  await pause(page);
  await page.click('text=Check me'); // checkbox via its label
  await pause(page);
  const range = await page.locator('#range').boundingBox(); // slider drag
  await page.mouse.move(range.x + range.width / 2, range.y + range.height / 2);
  await page.mouse.down();
  for (let dx = 8; dx <= 40; dx += 8) await page.mouse.move(range.x + range.width / 2 + dx, range.y + range.height / 2);
  await page.mouse.up();
  await pause(page);
  await page.dblclick('#dbl'); // double click
  await pause(page);
  await page.click('#mods', { modifiers: ['Shift'] }); // modifier click
  await pause(page);
  await page.mouse.click(700, 850); // click empty space to drop focus, like a user would
  await page.keyboard.press('j'); // single-key shortcut
  await page.keyboard.press('j');
  await pause(page);
  await page.setViewportSize({ width: 900, height: 800 }); // window resize
  await pause(page, 1500);

  const expected = await stateOf(page);
  console.log(`User's final state:\n  ${expected}`);
  const recorded = await call('react_recorded_actions');
  console.log('\n===== react_recorded_actions =====\n' + recorded);

  const has = (re) => re.test(recorded);
  check('hover recorded', has(/hover #menu/));
  check('mouse path over chart recorded', has(/move #chart \d+-point path/));
  check('pointer drag recorded', has(/drag \[data-testid="row-a"\].*-point path/));
  check('HTML5 drag and drop recorded', has(/dragTo #card-x → #zone/));
  check('mid-text edit recorded as caret + type', has(/caret #text at 6/) && has(/type "big "/));
  check('editor caret + keystrokes recorded', has(/caret #editor/) && has(/type "Hi there"/) && has(/press Backspace ×2/));
  check('right click recorded', has(/click \(right\) #ctx/));
  check('middle click recorded', has(/click \(middle\) #ctx/));
  check('ctrl+wheel recorded', has(/wheel \[Control\] #zoomable/));
  check('container scroll recorded', has(/scroll #scroller 300px/));
  check('long press recorded', has(/click #hold held \d{3}ms/));
  check('shadow DOM click recorded', has(/click [^\n]*lab-widget[^\n]* >> button/));
  check('SPA back recorded', has(/click #tab-b/) && has(/\d+\. \+[\d.]+s back —/));
  check('file upload recorded', has(/upload #file report\.csv/));
  check('select recorded', has(/select #color "blue"/));
  check('label click recorded once', (recorded.match(/Check me/g) ?? []).length === 1);
  check('slider drag recorded', has(/drag #range/));
  check('double click recorded (not two clicks)', has(/dblclick #dbl/) && !has(/\bclick #dbl/));
  check('modifier click recorded', has(/click \[Shift\] #mods/));
  check('click on empty space recorded with its position', has(/\d+\. \+[\d.]+s click at \(700,850\)/));
  check('key shortcut recorded', has(/press j ×2/));
  check('resize recorded', has(/resize 900×800/));

  await call('react_save_scenario', { name: 'lab', description: 'Every interaction type' });
  const run = await replayMatches('lab', expected);
  console.log('\n===== replay =====\n' + run.split('\n').filter((l) => /^(Scenario|Run on|  \d|  load)/.test(l)).join('\n'));
  check('replay ran every step', !/FAILED/.test(run));
  check('replay ends in exactly the user\'s state', /waitFor output#state:has-text/.test(run) && !/FAILED/.test(run));
  await context.close();

  // ---- Part B: a flow across full page loads, including a reload
  const context2 = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page2 = await context2.newPage();
  await page2.goto(base);
  await page2.waitForSelector('#state');
  await pause(page2, 400);
  await call('react_rerender_clear');
  await page2.click('#next');
  await page2.waitForSelector('#inc');
  await pause(page2, 300);
  await page2.click('#inc');
  await pause(page2, 400);
  await page2.reload();
  await page2.waitForSelector('#inc');
  await pause(page2, 300);
  await page2.click('#inc');
  await pause(page2, 1200);
  const expected2 = await stateOf(page2);
  const recorded2 = await call('react_recorded_actions');
  console.log('\n===== multi-page recording =====\n' + recorded2);
  await call('react_save_scenario', { name: 'lab-pages' });
  const saved2 = JSON.parse(await readFile(`${root}/perf/scenarios/lab-pages.json`, 'utf8'));
  check('one recording across page loads', /page load \/page2\.html/.test(recorded2) && /click #inc/.test(recorded2));
  check('link navigation replays from the click (no extra goto)', !saved2.steps.some((s) => s.action === 'goto'));
  check('reload kept as a step', saved2.steps.some((s) => s.action === 'reload'));
  check('recorded viewport saved', saved2.viewport?.width === 1200);
  const run2 = await replayMatches('lab-pages', expected2);
  check('multi-page replay ends in the same state', !/FAILED/.test(run2));
  check('multi-page replay measures commits on every page', /, [3-9]\d* commits,/.test(run2));
  await context2.close();
} finally {
  await client.close();
  await browser.close();
  await server.close();
  await rm(`${root}/perf`, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
