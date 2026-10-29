# react-performance-mcp

A Vite plugin that records **why every React component re-rendered** in your running app and serves it to AI agents over MCP. Then you can just say *"fix the performance of what I just did"*.

- Same reasons React DevTools shows in "Why did this render?": changed props, changed state hooks, changed context, parent re-rendered.
- Plus what DevTools can't tell you: whether a changed prop/state/context is a **real change** or a **new reference with identical contents** (an avoidable render).
- Traces each unstable prop to the component that **created** it, through any components that only passed it down, so the fix lands in the right file.
- Always on in dev. Nothing to start or stop; the data from your last interaction is already there.

## Setup

```js
// vite.config.js
import react from '@vitejs/plugin-react';
import { reactPerformanceMcp } from 'react-performance-mcp/vite';

export default defineConfig({
  plugins: [reactPerformanceMcp(), react()],
});
```

Start the dev server; it prints the MCP URL. Register it once:

```sh
claude mcp add --transport http react-perf http://localhost:5173/__react-perf/mcp
```

Open the app in any browser, do the slow thing, then tell the agent to fix it.

## MCP tools

| Tool | What it returns |
|---|---|
| `react_rerender_report` | Components ranked by wasted render time, with each re-render reason, real-vs-same-value, where the value was created, and fix ideas. |
| `react_recorded_actions` | What you just did in the browser, as replayable steps, with the React cost of each action. |
| `react_save_scenario` | Saves recorded actions (or explicit steps) as `perf/scenarios/<name>.json`, with optional budgets. |
| `react_list_scenarios` | Saved scenarios, their budgets and last result. |
| `react_run_scenario` | Agent opens the app in its own headless Chrome, performs scripted steps (type, click, select, scroll, …) and gets the report for exactly that run, with per-step timings and an optional screenshot. Lets the agent reproduce a slow flow and verify its fix without you. |
| `react_component_renders` | Render-by-render detail for one component (before → after values, changed paths like `[10].done: false → true`). |
| `react_commits` | Commit timeline: duration, what triggered it, heaviest components. |
| `react_rerender_clear` | Reset, so the next report only covers a fresh reproduction. |
| `react_rerender_status` | Connected tabs, React version, buffer size. |

### Record → reproduce → fix loop

You don't write scenarios. Just use the app: everything you do is recorded as replayable steps (with stable selectors and fallbacks), next to the React work each one caused. Then tell the agent *"that was slow, fix it"*:

| You do | Recorded as |
|---|---|
| Click: left/right/middle, with modifiers, long press, double click, empty space | `click` / `dblclick` with button, modifiers, hold time, position |
| Type in inputs, including edits mid-text | `type` (key by key), or `caret` + `press Backspace` + `type` |
| Type in rich-text editors (contenteditable) | `caret` offset + the exact keystrokes, Enter, Backspace, paste, shortcuts |
| Drag sortable lists, sliders, resizers, canvases | `drag` with start point, pointer path, duration |
| HTML5 drag and drop; dropping files | `dragTo`; `dropFiles` (placeholder files, same names and sizes) |
| Hover menus, tooltips, mouse-tracking charts | `hover`, or `move` with a pointer path (only when it made React work) |
| Scroll pages and containers; Ctrl+wheel and custom wheel handlers | `scroll`; `wheel` |
| Keyboard shortcuts, Tab, arrows, Enter, Escape | `press` (repeats collapsed) |
| Selects, checkboxes, radios, file inputs | `select`, `click`, `upload` |
| Resize the window | `resize` (the starting viewport is saved too) |
| Links, reloads, back/forward, SPA routes | one flow per tab across page loads; `reload` / `back` / `forward` / `goto` |
| Elements inside shadow DOM | `host >> inner` selectors |

Not captured: cross-origin iframes, popups/new tabs, multi-touch gestures (pinch), and native OS dialogs.

1. `react_recorded_actions`: the agent sees what you did and which action was expensive.
2. `react_save_scenario`: it saves the slow part to `perf/scenarios/<name>.json` (commit it).
3. `react_run_scenario({ name })`: it replays it in its own headless Chrome. Result: **PASS/FAIL** against budgets, the full re-render report, and a comparison with the previous run.
4. It fixes one cause, re-runs, keeps the change only if the numbers improved, and repeats until the scenario passes.

Default budgets are `{ maxCommitMs: 16, maxWastedMs: 5 }` (one 60fps frame, almost no wasted renders). Set your own per scenario, including per-component render limits. Use `cpuThrottle` to make problems visible on a fast machine, and `runs` to report the median of several runs. Run history is kept in `perf/scenarios/.results/` (gitignored).

### Scenarios

`react_run_scenario` uses `playwright-core` with your installed Chrome or Edge (no browser download). For example:

```json
{ "path": "/", "steps": [
  { "action": "type", "selector": "#search", "text": "glob" },
  { "action": "select", "selector": "#status", "value": "paid" },
  { "action": "click", "selector": "tbody tr >> nth=2" }
] }
```

Each run uses a fresh browser context, excludes the initial page load (unless `includeLoad`), and only counts commits from its own tab. Pages behind a login: pass Playwright `contextOptions` such as `{ storageState: 'auth.json' }`:

```js
reactPerformanceMcp({ scenario: { contextOptions: { storageState: 'auth.json' }, headless: true } })
```

## Example output

```
2. TodoItem (memo) — 222 renders across 50 instance(s); avoidable 221/222
   Why it re-rendered:
   - prop `onToggle` changed 222× (always same value) — created in App, passed down via TodoList.onToggle
   - prop `options` changed 222× (always same value) — created in TodoList
   Fix ideas:
   → `onToggle` is a new function each render with the same code: wrap it in useCallback in App.
   → `options` is a new object with the same contents each render: useMemo it in TodoList, or hoist it.
   → TodoItem is memoized but memo is defeated by unstable props `onToggle`, `options`.
```

## Notes

- Dev server only (`apply: 'serve'`); nothing is added to production builds.
- Works on React 16.9+, tested on 19.3. Hooks are reported by kind and order ("2nd useState"), as DevTools does.
- Coexists with react-refresh and the React DevTools extension (it wraps the existing DevTools hook).
- "Same value" for functions means identical source code — a fresh closure that `useCallback` would stabilize. Check the closure's dependencies before memoizing.
- Pages that aren't served from Vite's `index.html` (some SSR frameworks) don't get the script injected automatically.

## Development

```sh
npm install
npm run example   # realistic "Northwind Orders" dashboard on :5173 (MCP registered via .mcp.json)
npm run simulate  # drive the example in headless Chrome and print the MCP report
npm run demo      # minimal app with deliberate re-render problems (test fixture)
npm test          # end-to-end: report accuracy, scenarios, and record → replay of every interaction type
```
