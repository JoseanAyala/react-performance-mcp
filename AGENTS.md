# Agent instructions

<!-- Copy the section below into your app's AGENTS.md (Codex, Cursor, etc.) or CLAUDE.md.
     MCP clients that don't pass server instructions to the model still get the workflow this way. -->

## React performance (react-perf MCP)

This app runs the `react-performance-mcp` Vite plugin. While `vite dev` is running, the `react-perf` MCP server
(`http://localhost:5173/__react-perf/mcp`) has live data from the open app:

- Every React render, with why it happened (changed props, state hooks, context, or parent re-rendered) and whether
  each changed value is a real change or a new reference with identical contents (avoidable).
- Everything the user did in the browser, as replayable steps (clicks, typing, drags, hovers, scrolls, keys, uploads,
  resizes, navigation).

When the user says something is slow or asks to fix performance, run this loop:

1. **Capture.** Call `react_recorded_actions` to see what the user just did and the React cost of each action. Save the
   slow part with `react_save_scenario` (`fromStep`/`toStep`). If nothing was recorded, read the component source,
   script the interaction with `steps`, and save that instead.
2. **Baseline.** `react_run_scenario({ name })` returns PASS/FAIL against budgets, a Cascades section (which state
   change or `root.render()` started the renders), and per-component reasons.
3. **Diagnose.** `react_component_renders` on the top offenders for exact before → after values.
4. **Fix one cause at a time**, in the component that creates the unstable value, or move the state down to where
   it's used. Don't add `useMemo`/`useCallback` where the report says "real change".
5. **Verify.** Re-run `react_run_scenario({ name })`; it compares with the previous run. If the numbers got worse or
   a step failed, revert that change. Run the project's tests.
6. **Repeat** steps 3–5 until the scenario passes, nothing avoidable is left, or about 5 iterations. Finish with the
   before → after numbers.

Saved scenarios live in `perf/scenarios/*.json` and should be committed, so they can be re-run to catch regressions.
If a tool says no data or no pages are connected, ask the user to open the app from the dev server (and reload the tab).
