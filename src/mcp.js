import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { runScenario } from './scenario.js';
import { DEFAULT_BUDGETS, describeStep, formatRecordedActions, stepsFromActions } from './scenario-files.js';
import { formatCommits, formatComponentRenders, formatReport } from './store.js';

const INSTRUCTIONS = `Live React re-render diagnostics from the user's running Vite dev server.
Every component render in the open app is recorded continuously, with the same "why did this render?"
reasons React DevTools shows (changed props, state hooks, context, or parent re-rendered), plus whether
each changed value is a real change or a new reference with identical contents (avoidable).
Everything the user does is recorded too, as replayable steps: clicks (any button, modifiers, long press),
typing (inputs and rich-text editors, keystroke by keystroke), drags (pointer and HTML5), hovers that trigger
React work, scrolls, wheel, keyboard shortcuts, selects, uploads, resizes, and navigation across page loads.

When the user says something is slow or asks to fix performance, run this loop:
1. Capture: call react_recorded_actions to see what the user just did (with the React cost of each action).
   Save the slow part with react_save_scenario (pick fromStep/toStep). If nothing was recorded, read the
   component source, script the interaction yourself, and save that instead.
2. Baseline: react_run_scenario({ name }) — returns PASS/FAIL against budgets and the full re-render report.
3. Diagnose: react_component_renders on the top offenders for exact prop/state values.
4. Fix ONE cause at a time, in the component that creates the unstable value (or move state down).
5. Re-run react_run_scenario({ name }). It compares with the previous run. If the numbers got worse or the
   step failed, revert that change. Run the project's tests if it has them.
6. Repeat 3–5 until the scenario passes, nothing avoidable is left, or ~5 iterations. Then summarize the
   before → after numbers. Saved scenarios are files in the repo, so they can be re-run later to catch regressions.`;

const STEP = z.object({
  action: z
    .enum([
      'goto', 'reload', 'back', 'forward', 'click', 'dblclick', 'hover', 'move', 'drag', 'dragTo', 'fill', 'type', 'caret',
      'insertText', 'press', 'select', 'check', 'uncheck', 'upload', 'dropFiles', 'scroll', 'wheel', 'resize', 'wait', 'waitFor',
    ])
    .describe(
      'type = key-by-key typing (one render per keystroke); without selector it types into the focused element. ' +
        'caret = focus selector and put the caret at text `offset` (-1 = end). drag = pointer drag from `from` along `points` ' +
        '(deltas from the start). dragTo = HTML5 drag-and-drop onto `to`. move = mouse path over selector (`points` relative ' +
        'to its top-left). upload/dropFiles use placeholder files with the recorded names and sizes.',
    ),
  selector: z.string().optional().describe('CSS or Playwright selector, e.g. "#search", "tbody tr >> nth=2", "text=Save", "role=button[name=\\"Save\\"]".'),
  fallbackSelectors: z.array(z.string()).max(5).optional().describe('Tried in order if `selector` matches nothing or more than one element.'),
  text: z.string().optional().describe('Text for type/fill/insertText.'),
  value: z.string().optional().describe('Option value for select.'),
  values: z.array(z.string()).optional().describe('Option values for a multi-select.'),
  key: z.string().optional().describe('Key for press, e.g. "Enter", "ArrowDown", "Meta+k".'),
  url: z.string().optional().describe('Path or URL for goto.'),
  ms: z.number().optional().describe('Duration for wait.'),
  x: z.number().optional().describe('Horizontal pixels for scroll.'),
  y: z.number().optional().describe('Vertical pixels for scroll (default 600).'),
  dx: z.number().optional().describe('Wheel delta x.'),
  dy: z.number().optional().describe('Wheel delta y.'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional().describe('Point relative to the element top-left.'),
  delay: z.number().optional().describe('Hold time for click, ms (long press).'),
  offset: z.number().int().optional().describe('Caret text offset for caret (-1 = end).'),
  from: z.object({ x: z.number(), y: z.number() }).optional().describe('Drag start, relative to the element top-left.'),
  points: z.array(z.array(z.number()).min(2).max(2)).max(200).optional().describe('Drag deltas or move positions as [x, y] pairs.'),
  duration: z.number().optional().describe('Duration of a drag/move, ms.'),
  to: z.string().optional().describe('Drop target selector for dragTo (informational for drag).'),
  files: z.array(z.object({ name: z.string(), type: z.string().optional(), size: z.number().optional() })).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  repeat: z.number().int().positive().max(200).optional().describe('Repeat this step N times.'),
});

const BUDGETS = z
  .object({
    maxCommitMs: z.number().positive().optional().describe('Slowest single commit, ms (16 = one frame at 60fps).'),
    maxWastedMs: z.number().min(0).optional().describe('Total self time of avoidable renders, ms.'),
    maxAvoidableRenders: z.number().int().min(0).optional(),
    maxRenders: z.number().int().min(0).optional(),
    components: z.record(z.string(), z.object({ maxRenders: z.number().int().min(0) })).optional(),
  })
  .describe(`Pass/fail limits for the scenario. Default when unset: ${JSON.stringify(DEFAULT_BUDGETS)}.`);

export function createMcpServer(store, options) {
  const server = new McpServer({ name: 'react-performance', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'react_rerender_report',
    {
      title: 'React re-render report',
      description:
        'Which React components re-rendered, how often, how long they took, and WHY (changed props/state/context or parent ' +
        're-render), with avoidable renders flagged and fix suggestions. Start here for any React performance problem.',
      inputSchema: {
        sinceSeconds: z.number().positive().optional().describe('Only include commits from the last N seconds.'),
        component: z.string().optional().describe('Only include components whose name contains this text.'),
        sort: z.enum(['wasted', 'time', 'count']).optional().describe('wasted (default): avoidable render time; time: total self time; count: number of renders.'),
        limit: z.number().int().positive().max(100).optional().describe('Max components to list (default 15).'),
        url: z.string().optional().describe('Only include pages whose URL contains this text.'),
      },
    },
    async ({ sinceSeconds, component, sort, limit, url }) =>
      text(formatReport(store.select({ sinceSeconds, url }), { sort, limit, component })),
  );

  server.registerTool(
    'react_recorded_actions',
    {
      title: "User's recorded interactions",
      description:
        "What the user just did in their browser (clicks, typing, selects, key presses, scrolls), as replayable steps, " +
        'with the React work each action caused. Use it to find the slow interaction, then save it with react_save_scenario.',
      inputSchema: {
        sinceSeconds: z.number().positive().optional().describe('Only actions from the last N seconds.'),
      },
    },
    async ({ sinceSeconds }) => {
      const selection = store.selectActions({ from: sinceSeconds ? Date.now() - sinceSeconds * 1000 : 0 });
      return text(formatRecordedActions(selection, store.select({ tab: selection.tab })));
    },
  );

  server.registerTool(
    'react_save_scenario',
    {
      title: 'Save a replayable scenario',
      description:
        "Saves a scenario file (perf/scenarios/<name>.json) from the user's recorded interactions (default) or from explicit " +
        'steps. Saved scenarios are re-run by name with react_run_scenario, which then checks budgets and compares with the ' +
        'previous run. Call again with only name + budgets/description to update an existing scenario.',
      inputSchema: {
        name: z.string().describe('File-safe name, e.g. "search-orders".'),
        description: z.string().optional().describe('What the interaction is and why it matters.'),
        fromStep: z.number().int().positive().optional().describe('First recorded action to keep (1-based, from react_recorded_actions).'),
        toStep: z.number().int().positive().optional().describe('Last recorded action to keep.'),
        sinceSeconds: z.number().positive().optional().describe('Only recorded actions from the last N seconds.'),
        steps: z.array(STEP).max(200).optional().describe('Explicit steps instead of the recording.'),
        path: z.string().optional().describe('Start page path (default: where the recording started, or "/").'),
        budgets: BUDGETS.optional(),
        cpuThrottle: z.number().min(1).max(20).optional().describe('Slow the CPU N× during runs to surface problems on fast machines.'),
        runs: z.number().int().min(1).max(9).optional().describe('Runs per check; the median is reported (default 1).'),
      },
    },
    async (input) => {
      try {
        return text(await saveScenario(store, options.scenarioFiles, input));
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] };
      }
    },
  );

  server.registerTool(
    'react_list_scenarios',
    {
      title: 'Saved scenarios',
      description: 'Saved scenarios with their budgets and the result of their last run.',
      inputSchema: {},
    },
    async () => {
      const list = await options.scenarioFiles.list();
      if (!list.length) return text(`No saved scenarios in ${options.scenarioFiles.dir}.`);
      return text(
        list
          .map((s) => {
            const last = s.last ? `last run ${s.last.passed ? 'PASS' : 'FAIL'} (${s.last.metrics.avoidableRenders} avoidable, ${s.last.metrics.wastedMs}ms wasted, slowest commit ${s.last.metrics.maxCommitMs}ms)` : 'never run';
            return `- ${s.name}: ${s.description ?? ''} — ${s.steps.length} steps from ${s.path}; ${last}; budgets ${JSON.stringify(s.budgets ?? DEFAULT_BUDGETS)}`;
          })
          .join('\n'),
      );
    },
  );

  server.registerTool(
    'react_run_scenario',
    {
      title: 'Run an interaction and measure re-renders',
      description:
        'Opens the app in a headless browser from this dev server, performs the steps of a saved scenario (`name`) or the ' +
        'given `steps`, and returns the re-render report for exactly that run: per-step timings, why each component ' +
        're-rendered, avoidable renders, and the commit timeline. For saved scenarios it also returns PASS/FAIL against ' +
        'budgets and a comparison with the previous run — use it to verify every fix. Initial page load is excluded unless includeLoad is true.',
      inputSchema: {
        name: z.string().optional().describe('Saved scenario to run (see react_list_scenarios).'),
        path: z.string().optional().describe('Page path to open, e.g. "/orders" (default "/").'),
        steps: z.array(STEP).max(200).optional().describe('Interactions to perform in order (ad-hoc run, not saved).'),
        settleMs: z.number().int().min(0).max(10_000).optional().describe('Wait after load and after the last step (default 500).'),
        includeLoad: z.boolean().optional().describe('Include the initial mount in the report (default false).'),
        runs: z.number().int().min(1).max(9).optional().describe('Run N times and report the median run.'),
        cpuThrottle: z.number().min(1).max(20).optional().describe('Slow the CPU N× during the run.'),
        screenshot: z.boolean().optional().describe('Attach a screenshot of the final state.'),
        sort: z.enum(['wasted', 'time', 'count']).optional(),
        limit: z.number().int().positive().max(100).optional().describe('Max components in the report (default 15).'),
      },
    },
    async (input) => {
      try {
        return { content: await runScenario(store, options, input) };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] };
      }
    },
  );

  server.registerTool(
    'react_component_renders',
    {
      title: 'Renders of one component',
      description:
        'Render-by-render detail for one component: each changed prop/state/context with before → after values and whether ' +
        'it was a real change, plus parent/owner and what triggered the commit.',
      inputSchema: {
        name: z.string().describe('Component display name, e.g. "TodoItem".'),
        limit: z.number().int().positive().max(200).optional().describe('Most recent N renders (default 20).'),
        sinceSeconds: z.number().positive().optional(),
      },
    },
    async ({ name, limit, sinceSeconds }) => text(formatComponentRenders(store.select({ sinceSeconds }), name, limit)),
  );

  server.registerTool(
    'react_commits',
    {
      title: 'React commit timeline',
      description: 'Timeline of React commits: duration, how many components rendered, what triggered each, and the heaviest components.',
      inputSchema: {
        limit: z.number().int().positive().max(500).optional().describe('Most recent N commits (default 30).'),
        sinceSeconds: z.number().positive().optional(),
      },
    },
    async ({ limit, sinceSeconds }) => text(formatCommits(store.select({ sinceSeconds }), limit)),
  );

  server.registerTool(
    'react_rerender_clear',
    {
      title: 'Clear recorded renders',
      description: 'Discard recorded renders and recorded user interactions, so the next report and recording only cover what happens next. Then ask the user to reproduce the slow interaction.',
      inputSchema: {},
    },
    async () => {
      store.clear();
      return text('Cleared. Ask the user to reproduce the slow interaction now, then call react_rerender_report.');
    },
  );

  server.registerTool(
    'react_rerender_status',
    {
      title: 'Recorder status',
      description: 'Which browser tabs are connected, React versions, and how many commits are buffered.',
      inputSchema: {},
    },
    async () => {
      const { sessions, commitCount, clearedAt } = store.status();
      const now = Date.now();
      const lines = [`${commitCount} commits buffered${clearedAt ? ` (cleared ${Math.round((now - clearedAt) / 1000)}s ago)` : ''}.`];
      if (!sessions.size) lines.push('No pages have connected yet. Open the app from this Vite dev server in a browser.');
      for (const s of sessions.values()) {
        lines.push(
          `- ${s.url} — React ${s.reactVersions.join(', ') || 'unknown'}, last data ${Math.round((now - s.lastSeen) / 1000)}s ago` +
            (s.error ? `\n  recorder error: ${s.error.split('\n')[0]}` : ''),
        );
      }
      return text(lines.join('\n'));
    },
  );

  return server;
}

// Stateless Streamable HTTP: a fresh server + transport per request.
export async function handleMcpRequest(store, options, req, res) {
  const server = createMcpServer(store, options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

async function saveScenario(store, files, input) {
  const existing = (await files.exists(input.name)) ? await files.load(input.name) : null;
  let recorded = null;
  if (!input.steps) {
    const selection = store.selectActions({ from: input.sinceSeconds ? Date.now() - input.sinceSeconds * 1000 : 0 });
    const actions = selection.actions.slice((input.fromStep ?? 1) - 1, input.toStep ?? undefined);
    if (actions.length) recorded = stepsFromActions(actions);
  }
  const steps = input.steps ?? recorded?.steps ?? existing?.steps;
  if (!steps?.length) {
    throw new Error('Nothing to save: no recorded interactions (ask the user to do the interaction in their browser first) and no `steps` given.');
  }

  const { name: _name, ...previous } = existing ?? {};
  const scenario = {
    ...previous,
    name: input.name,
    ...(input.description !== undefined && { description: input.description }),
    path: input.path ?? recorded?.path ?? existing?.path ?? '/',
    ...((recorded?.viewport ?? existing?.viewport) && { viewport: recorded?.viewport ?? existing?.viewport }),
    steps,
    ...(input.budgets && { budgets: input.budgets }),
    ...(input.cpuThrottle !== undefined && { cpuThrottle: input.cpuThrottle }),
    ...(input.runs !== undefined && { runs: input.runs }),
  };
  const file = await files.save(scenario);
  const source = input.steps ? 'given steps' : recorded ? 'recorded interactions' : 'existing steps (metadata updated)';
  return [
    `Saved ${file} (${steps.length} steps from ${source}), starting at ${scenario.path}:`,
    ...steps.map((s, i) => `  ${i + 1}. ${describeStep(s)}`),
    `Budgets: ${JSON.stringify(scenario.budgets ?? DEFAULT_BUDGETS)}${scenario.budgets ? '' : ' (defaults)'}`,
    '',
    `Next: react_run_scenario({ name: "${input.name}" }) to get the baseline.`,
  ].join('\n');
}

function text(value) {
  return { content: [{ type: 'text', text: value }] };
}
