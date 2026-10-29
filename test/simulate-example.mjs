import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const shot = process.argv[2]; // optional screenshot path
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto('http://localhost:5173/');
await page.waitForSelector('tbody tr');
const client = new Client({ name: 'session', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:5173/__react-perf/mcp')));
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
await page.waitForTimeout(500);           // let the initial mount commit flush first
await call('react_rerender_clear');
await page.waitForTimeout(3200);            // let the page sit idle (clock ticks)
await page.type('#search', 'glob', { delay: 60 });
await page.selectOption('#status', 'paid');
await page.click('tbody tr >> nth=2');
await page.click('tbody tr >> nth=4');
await page.click('.topbar button');
await page.waitForTimeout(600);
if (shot) await page.screenshot({ path: shot });
console.log(await call('react_rerender_report', { limit: 8 }));
console.log('\n----- commits -----\n' + await call('react_commits', { limit: 8 }));
await client.close(); await browser.close();
