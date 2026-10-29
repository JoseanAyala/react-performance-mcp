// Saved scenarios (perf/scenarios/<name>.json, meant to be committed) and their run history
// (perf/scenarios/.results/<name>.json, gitignored), plus budgets and run-to-run comparison.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { metrics as computeMetrics } from './store.js';

// Used when a scenario doesn't define its own: one frame at 60fps, almost no wasted work.
export const DEFAULT_BUDGETS = { maxCommitMs: 16, maxWastedMs: 5 };
const MAX_WAIT_MS = 5000;
const MIN_WAIT_MS = 1000;
const HISTORY = 20;

export function createScenarioFiles(dir) {
  const resultsDir = path.join(dir, '.results');
  const file = (name) => path.join(dir, `${checkName(name)}.json`);

  return {
    dir,

    async list() {
      const names = await readdir(dir).catch(() => []);
      const out = [];
      for (const entry of names.filter((n) => n.endsWith('.json')).sort()) {
        const name = entry.slice(0, -5);
        const scenario = await this.load(name).catch(() => null);
        if (!scenario) continue;
        const history = await this.history(name);
        out.push({ ...scenario, last: history.at(-1) ?? null });
      }
      return out;
    },

    async load(name) {
      const text = await readFile(file(name), 'utf8').catch(() => {
        throw new Error(`No saved scenario "${name}" in ${dir}. Use react_list_scenarios to see saved ones.`);
      });
      return { name, ...JSON.parse(text) };
    },

    async exists(name) {
      return readFile(file(name)).then(() => true, () => false);
    },

    async save({ name, ...scenario }) {
      await mkdir(dir, { recursive: true });
      await writeFile(file(name), JSON.stringify(scenario, null, 2) + '\n');
      return file(name);
    },

    async history(name) {
      const text = await readFile(path.join(resultsDir, `${checkName(name)}.json`), 'utf8').catch(() => '[]');
      return JSON.parse(text);
    },

    async addResult(name, result) {
      await mkdir(resultsDir, { recursive: true });
      await writeFile(path.join(resultsDir, '.gitignore'), '*\n');
      const history = [...(await this.history(name)), result].slice(-HISTORY);
      await writeFile(path.join(resultsDir, `${checkName(name)}.json`), JSON.stringify(history, null, 2) + '\n');
    },
  };
}

function checkName(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
    throw new Error(`Invalid scenario name "${name}": use letters, numbers, - and _.`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Recorded actions → steps

const CAUSES_NAVIGATION = /^(click|dblclick|press|dragTo|drag|back|forward|goto|reload)$/;

// Page-load markers become goto/reload steps only when no recorded action caused them.
export function stepsFromActions(actions) {
  const steps = [];
  let path = null;
  let viewport = null;
  let prev = null;
  for (const a of actions) {
    if (a.action === 'load') {
      viewport ??= a.viewport ?? null;
      if (path === null && !steps.length) {
        path = a.path;
      } else {
        // Reloads and back/forward come from browser UI; a plain navigation right after a click is that click's doing.
        const caused = a.navType === 'navigate' && prev && CAUSES_NAVIGATION.test(prev.action) && a.t - (prev.end ?? prev.t) < 5000;
        if (a.navType === 'reload') steps.push({ action: 'reload' });
        else if (!caused) steps.push({ action: 'goto', url: a.path });
      }
      prev = a;
      continue;
    }
    if (path === null) path = a.path;
    if (prev) {
      const gap = a.t - (prev.end ?? prev.t);
      if (gap >= MIN_WAIT_MS) steps.push({ action: 'wait', ms: Math.min(MAX_WAIT_MS, Math.round(gap / 100) * 100) });
    }
    const { t, end, path: _path, tab, navType, continued, ...step } = a;
    steps.push(step);
    prev = a;
  }
  return { path: path ?? '/', viewport, steps };
}

export function formatRecordedActions(selection, commits) {
  const { actions, url } = selection;
  if (!actions.some((a) => a.action !== 'load')) {
    return 'No interactions recorded yet. Ask the user to do the slow interaction in their browser (it is recorded automatically), then call this again.';
  }
  const lines = [
    `${actions.length} recorded event(s) in the user's tab (now on ${url ?? actions.at(-1).path}):`,
    '(cost = React commits caused until the next action)',
    '',
  ];
  actions.forEach((a, i) => {
    const offset = ((a.t - actions[0].t) / 1000).toFixed(1);
    // Steps split from one gesture (caret + typing) share a timestamp; the cost goes on the last of them.
    const sameGesture = actions[i + 1]?.t === a.t;
    const until = actions.slice(i + 1).find((n) => n.t > a.t)?.t ?? Infinity;
    const caused = sameGesture ? [] : commits.filter((c) => c.tab === a.tab && c.t >= a.t && c.t < until);
    const m = computeMetrics(caused);
    const cost = sameGesture
      ? '↓'
      : caused.length
        ? `${m.commits} commits, ${m.renders} renders (${m.avoidableRenders} avoidable), slowest commit ${m.maxCommitMs}ms`
        : 'no React work';
    const what = a.action === 'load' ? `page load ${a.path} (${a.navType}${a.viewport ? `, ${a.viewport.width}×${a.viewport.height}` : ''})` : describeStep(a);
    lines.push(`${i + 1}. +${offset}s ${what} — ${cost}`);
  });
  lines.push('', 'Save these as a replayable scenario with react_save_scenario (fromStep/toStep to keep a subset).');
  return lines.join('\n');
}

export function describeStep(step) {
  const parts = [step.action];
  if (step.button) parts.push(`(${step.button})`);
  if (step.modifiers) parts.push(`[${step.modifiers.join('+')}]`);
  if (step.selector) parts.push(step.selector);
  if (step.to) parts.push(`→ ${step.to}`);
  if (step.text !== undefined) parts.push(JSON.stringify(step.text));
  if (step.value !== undefined) parts.push(JSON.stringify(step.value));
  if (step.values) parts.push(JSON.stringify(step.values));
  if (step.key) parts.push(step.key);
  if (step.url) parts.push(step.url);
  if (step.offset !== undefined) parts.push(step.offset < 0 ? 'at end' : `at ${step.offset}`);
  if (step.files) parts.push(step.files.map((f) => f.name).join(', '));
  if (step.points) parts.push(`${step.points.length}-point path over ${step.duration}ms`);
  if (step.position) parts.push(`at (${step.position.x},${step.position.y})`);
  if (step.ms) parts.push(`${step.ms}ms`);
  if (step.action === 'scroll') parts.push(`${step.y}px${step.x ? `, x ${step.x}px` : ''}`);
  if (step.action === 'wheel') parts.push(`Δ${step.dx},${step.dy}`);
  if (step.action === 'resize') parts.push(`${step.width}×${step.height}`);
  if (step.delay) parts.push(`held ${step.delay}ms`);
  if (step.repeat > 1) parts.push(`×${step.repeat}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Budgets and comparison

export function checkBudgets(m, budgets) {
  const checks = [];
  const add = (label, actual, limit) => checks.push({ label, actual, limit, ok: actual <= limit });
  if (budgets.maxCommitMs != null) add('maxCommitMs', m.maxCommitMs, budgets.maxCommitMs);
  if (budgets.maxWastedMs != null) add('maxWastedMs', m.wastedMs, budgets.maxWastedMs);
  if (budgets.maxAvoidableRenders != null) add('maxAvoidableRenders', m.avoidableRenders, budgets.maxAvoidableRenders);
  if (budgets.maxRenders != null) add('maxRenders', m.renders, budgets.maxRenders);
  for (const [name, limits] of Object.entries(budgets.components ?? {})) {
    if (limits.maxRenders != null) add(`${name}.maxRenders`, m.components[name] ?? 0, limits.maxRenders);
  }
  return checks;
}

const COMPARED = [
  ['avoidableRenders', 'avoidable renders', ''],
  ['wastedMs', 'wasted render time', 'ms'],
  ['maxCommitMs', 'slowest commit', 'ms'],
  ['renders', 'total renders', ''],
  ['commits', 'commits', ''],
];

export function compareMetrics(prev, cur) {
  const lines = [];
  for (const [key, label, unit] of COMPARED) {
    const a = prev[key];
    const b = cur[key];
    if (a === undefined) continue;
    const change = a === 0 ? (b === 0 ? '' : ' (new)') : ` (${b >= a ? '+' : ''}${Math.round(((b - a) / a) * 100)}%)`;
    const mark = b < a ? '↓' : b > a ? '↑' : '=';
    lines.push(`${mark} ${label}: ${a}${unit} → ${b}${unit}${change}`);
  }
  const names = new Set([...Object.keys(prev.components ?? {}), ...Object.keys(cur.components ?? {})]);
  const deltas = [...names]
    .map((n) => [n, (prev.components?.[n] ?? 0), (cur.components?.[n] ?? 0)])
    .filter(([, a, b]) => a !== b)
    .sort((x, y) => Math.abs(y[2] - y[1]) - Math.abs(x[2] - x[1]))
    .slice(0, 5);
  if (deltas.length) lines.push(`  renders by component: ${deltas.map(([n, a, b]) => `${n} ${a}→${b}`).join(', ')}`);
  return lines;
}
