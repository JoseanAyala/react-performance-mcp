import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMcpRequest } from './mcp.js';
import { closeScenarioBrowser } from './scenario.js';
import { createScenarioFiles } from './scenario-files.js';
import { createStore } from './store.js';

const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL('./client.js', import.meta.url)), 'utf8');
const MAX_BODY = 10 * 1024 * 1024;

/**
 * @param {import('./vite.d.ts').ReactPerformanceMcpOptions} [options]
 * @returns {import('vite').Plugin}
 */
export function reactPerformanceMcp(options = {}) {
  const prefix = '/' + (options.path ?? '__react-perf').replace(/^\/+|\/+$/g, '');
  const serverName = options.name ?? 'react-perf';
  const store = createStore();
  let base = '/';
  let baseUrl = null;
  const mcpOptions = { scenario: options.scenario, getBaseUrl: () => baseUrl, scenarioFiles: null };

  return {
    name: 'react-performance-mcp',
    apply: 'serve',

    configResolved(config) {
      base = config.base.endsWith('/') ? config.base : config.base + '/';
      mcpOptions.scenarioFiles = createScenarioFiles(path.resolve(config.root, options.scenariosDir ?? 'perf/scenarios'));
    },

    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [
          {
            tag: 'script',
            attrs: { src: base.replace(/\/$/, '') + prefix + '/client.js' },
            injectTo: 'head-prepend',
          },
        ];
      },
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0].replace(base.replace(/\/$/, ''), '');
        if (!path.startsWith(prefix + '/')) return next();
        const route = path.slice(prefix.length);
        try {
          if (route === '/client.js') {
            const endpoint = base.replace(/\/$/, '') + prefix;
            res.setHeader('content-type', 'text/javascript');
            res.setHeader('cache-control', 'no-store');
            res.end(CLIENT_SOURCE.replaceAll('__ENDPOINT__', endpoint));
          } else if (route === '/ingest' && req.method === 'POST') {
            store.ingest(JSON.parse(await readBody(req)));
            res.statusCode = 204;
            res.end();
          } else if (route === '/mcp') {
            await handleMcpRequest(store, mcpOptions, req, res);
          } else {
            next();
          }
        } catch (error) {
          server.config.logger.error(`[react-performance-mcp] ${error?.stack ?? error}`);
          if (!res.headersSent) res.statusCode = 500;
          res.end();
        }
      });

      server.httpServer?.once('close', closeScenarioBrowser);
      server.httpServer?.once('listening', () => {
        setTimeout(() => {
          const url = (server.resolvedUrls?.local[0] ?? `http://localhost:${server.config.server.port}/`).replace(/\/$/, '');
          baseUrl = url + base;
          server.config.logger.info(
            `\n  React re-render MCP: ${url}${prefix}/mcp\n` +
              `  Add to Claude Code: claude mcp add --transport http ${serverName} ${url}${prefix}/mcp\n`,
          );
        }, 0);
      });
    },
  };
}

export default reactPerformanceMcp;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('ingest payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
