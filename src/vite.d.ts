import type { Plugin } from 'vite';

export interface ReactPerformanceMcpOptions {
  /** URL prefix for the plugin's endpoints. Default: "__react-perf" (MCP at /__react-perf/mcp). */
  path?: string;
  /** Server name used in the printed `claude mcp add` command. Default: "react-perf". */
  name?: string;
  /** Where saved scenarios live, relative to the Vite root. Default: "perf/scenarios". */
  scenariosDir?: string;
  /** Browser used by the react_run_scenario tool (needs playwright-core installed). */
  scenario?: {
    /** "chrome" | "msedge" | "chromium". Default: tries chrome, msedge, then Playwright's chromium. */
    channel?: string;
    /** Path to a Chromium-based browser binary. */
    executablePath?: string;
    /** Set to false to watch scenarios run in a visible browser window. Default: true. */
    headless?: boolean;
    /** Extra Playwright BrowserContext options, e.g. { storageState: 'auth.json' } for logged-in flows. */
    contextOptions?: Record<string, unknown>;
  };
}

export declare function reactPerformanceMcp(options?: ReactPerformanceMcpOptions): Plugin;
export default reactPerformanceMcp;
