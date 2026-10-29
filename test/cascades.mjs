// Root-level cascades: root.render() from an external store, and state at the top of the tree.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = fileURLToPath(new URL('./lab', import.meta.url));
const server = await createServer({ root, configFile: `${root}/vite.config.js`, server: { port: 5196, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const client = new Client({ name: 'cascades', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5196/__react-perf/mcp')));
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
let failed = false;
const check = (label, ok) => {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
};

try {
  const page = await browser.newPage();
  await page.goto('http://localhost:5196/root-render.html');
  await page.waitForSelector('#count');
  await page.waitForTimeout(400);
  const initial = await call('react_commits');
  check('first commit is labeled as the initial render', /triggered by initial render/.test(initial));

  await call('react_rerender_clear');
  await page.click('#external');
  await page.click('#external');
  await page.click('#theme');
  await page.waitForTimeout(600);

  const commits = await call('react_commits');
  const report = await call('react_rerender_report', { limit: 3 });
  console.log(commits + '\n\n' + report.split('\n').slice(0, 14).join('\n'));
  check('root.render() commits are labeled', (commits.match(/triggered by root\.render\(\)/g) ?? []).length === 2);
  check('cascades section ranks triggers', /Cascades — what started the renders/.test(report));
  check('root.render() cascade counts the whole tree', /1\. root\.render\(\): called ×2 → 64 renders in 2 commit/.test(report));
  check('root.render() gets the subscribe hint', /Subscribe the components that need the data/.test(report));
  check('state cascade names the hook and covers its context consumers', /\d\. App: state \(1st useState\) ×1 → 32 renders in 1 commit/.test(report));
} finally {
  await client.close();
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
