// In-memory buffer of commits posted by the page, plus the aggregations the MCP tools return.

const MAX_COMMITS = 5000;
const MAX_ACTIONS = 5000;

export function createStore() {
  /** @type {Map<string, {tab: string, url: string, title: string, reactVersions: string[], error: string | null, firstSeen: number, lastSeen: number}>} */
  const sessions = new Map();
  /** @type {Array<any>} */
  let commits = [];
  /** @type {Array<any>} */
  let actions = [];
  let clearedAt = null;

  return {
    // Commits and actions are grouped by browser tab, so flows across full page loads stay together.
    ingest(payload) {
      const now = Date.now();
      const tab = payload.tabId ?? payload.sessionId;
      const session = sessions.get(payload.sessionId) ?? { firstSeen: now };
      sessions.set(payload.sessionId, {
        ...session,
        tab,
        url: payload.url,
        title: payload.title,
        reactVersions: payload.reactVersions ?? [],
        error: payload.error ?? null,
        lastSeen: now,
      });
      for (const commit of payload.commits ?? []) {
        commit.tab = tab;
        commits.push(commit);
      }
      if (commits.length > MAX_COMMITS) commits = commits.slice(-MAX_COMMITS);
      for (const action of payload.actions ?? []) {
        action.tab = tab;
        actions.push(action);
      }
      if (actions.length > MAX_ACTIONS) actions = actions.slice(-MAX_ACTIONS);
    },

    clear() {
      commits = [];
      actions = [];
      clearedAt = Date.now();
    },

    // Recorded user actions, by default from the tab the user last interacted with.
    selectActions({ tab, from = 0 } = {}) {
      const target = tab ?? actions.findLast((a) => a.action !== 'load')?.tab;
      if (!target) return { tab: null, actions: [] };
      const latest = [...sessions.values()].filter((s) => s.tab === target).sort((a, b) => b.lastSeen - a.lastSeen)[0];
      return { tab: target, url: latest?.url ?? null, actions: actions.filter((a) => a.tab === target && a.t >= from) };
    },

    status() {
      return { sessions, commitCount: commits.length, clearedAt };
    },

    select({ sinceSeconds, url, tab, from: fromTime } = {}) {
      const from = fromTime ?? (sinceSeconds ? Date.now() - sinceSeconds * 1000 : 0);
      const tabsForUrl = url ? new Set([...sessions.values()].filter((s) => s.url.includes(url)).map((s) => s.tab)) : null;
      return commits.filter((c) => c.t >= from && (!tab || c.tab === tab) && (!tabsForUrl || tabsForUrl.has(c.tab)));
    },

    forget(tab) {
      for (const [id, s] of sessions) if (s.tab === tab) sessions.delete(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Metrics (what budgets and run-to-run comparisons are based on)

export function metrics(commits) {
  const components = new Map();
  let renders = 0;
  let avoidable = 0;
  let wastedMs = 0;
  let maxCommitMs = 0;
  let totalCommitMs = 0;
  for (const commit of commits) {
    renders += commit.renders.length + (commit.truncated ?? 0);
    maxCommitMs = Math.max(maxCommitMs, commit.duration ?? 0);
    totalCommitMs += commit.duration ?? 0;
    for (const r of commit.renders) {
      components.set(r.name, (components.get(r.name) ?? 0) + 1);
      if (r.avoidable) {
        avoidable++;
        wastedMs += r.self ?? 0;
      }
    }
  }
  return {
    commits: commits.length,
    renders,
    avoidableRenders: avoidable,
    wastedMs: round(wastedMs),
    maxCommitMs: round(maxCommitMs),
    totalCommitMs: round(totalCommitMs),
    components: Object.fromEntries([...components.entries()].sort((a, b) => b[1] - a[1])),
  };
}

function round(n) {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Aggregation

export function aggregate(commits) {
  const byName = new Map();
  for (const commit of commits) {
    for (const r of commit.renders) {
      let c = byName.get(r.name);
      if (!c) {
        c = {
          name: r.name,
          renders: 0,
          mounts: 0,
          avoidable: 0,
          time: 0,
          self: 0,
          avoidableSelf: 0,
          maxSelf: 0,
          memo: false,
          instances: new Set(),
          owners: new Map(),
          sites: new Set(),
          causes: { props: 0, state: 0, context: 0, parent: 0 },
          props: new Map(),
          state: new Map(),
          context: new Map(),
          origins: new Map(),
        };
        byName.set(r.name, c);
      }
      c.renders++;
      c.instances.add(r.id);
      c.memo ||= r.memo;
      c.time += r.dur ?? 0;
      c.self += r.self ?? 0;
      c.maxSelf = Math.max(c.maxSelf, r.self ?? 0);
      if (r.owner) bump(c.owners, r.owner);
      if (r.at && c.sites.size < 3) c.sites.add(r.at);
      if (r.mount) {
        c.mounts++;
        continue;
      }
      if (r.avoidable) {
        c.avoidable++;
        c.avoidableSelf += r.self ?? 0;
      }
      if (r.props) c.causes.props++;
      if (r.state) c.causes.state++;
      if (r.context) c.causes.context++;
      if (r.parentOnly) c.causes.parent++;
      for (const ch of r.props ?? []) addChange(c.props, ch);
      for (const ch of r.state ?? []) addChange(c.state, ch);
      for (const ch of r.context ?? []) addChange(c.context, ch);
      if (r.origin) bump(c.origins, r.origin);
    }
  }
  return [...byName.values()];
}

function addChange(map, ch) {
  let entry = map.get(ch.key);
  if (!entry) {
    entry = { key: ch.key, kind: ch.kind, count: 0, sameValue: 0, example: null, createdIn: null, via: null };
    map.set(ch.key, entry);
  }
  entry.count++;
  if (ch.sameValue) entry.sameValue++;
  if (ch.createdIn) {
    entry.createdIn = ch.createdIn;
    entry.via = ch.via ?? null;
  }
  entry.example = describeExample(ch);
}

function describeExample(ch) {
  return ch.diff ?? `${ch.prev} → ${ch.next}`;
}

function origin(entry) {
  if (!entry.createdIn) return '';
  return ` — created in ${entry.createdIn}` + (entry.via ? `, passed down via ${entry.via.join(' → ')}` : '');
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

const SORTS = {
  wasted: (a, b) => b.avoidableSelf - a.avoidableSelf || b.avoidable - a.avoidable || b.self - a.self,
  time: (a, b) => b.self - a.self || b.renders - a.renders,
  count: (a, b) => b.renders - a.renders || b.self - a.self,
};

// ---------------------------------------------------------------------------
// Formatting (plain text tuned for LLM consumption)

const ROOT_TRIGGERS = new Set(['root.render()', 'initial render']);

// Groups every render under what started it: the nearest ancestor whose own state changed, or
// root.render() / the initial render when nothing inside the tree did.
export function aggregateCascades(commits) {
  const byTrigger = new Map();
  for (const commit of commits) {
    const rootTrigger = commit.updaters?.find((u) => ROOT_TRIGGERS.has(u)) ?? null;
    for (const r of commit.renders) {
      const key = r.ownReason ? r.name : r.origin ?? rootTrigger ?? commit.updaters?.[0] ?? 'unknown trigger';
      let c = byTrigger.get(key);
      if (!c) {
        c = { name: key, causes: new Map(), commits: new Set(), renders: 0, mounts: 0, avoidable: 0, time: 0, affected: new Map() };
        byTrigger.set(key, c);
      }
      c.commits.add(commit);
      c.renders++;
      if (r.mount) c.mounts++;
      if (r.avoidable) c.avoidable++;
      c.time += r.self ?? 0;
      if (r.name !== key) c.affected.set(r.name, (c.affected.get(r.name) ?? 0) + (r.self ?? 0));
      if (r.ownReason && r.name === key) {
        for (const s of r.state ?? []) bump(c.causes, `state (${s.key})`);
        for (const x of r.context ?? []) bump(c.causes, `context ${x.key}`);
      }
    }
  }
  return [...byTrigger.values()].sort((a, b) => b.time - a.time || b.renders - a.renders);
}

function formatCascades(cascades) {
  const lines = ['Cascades — what started the renders, by total render time:'];
  cascades.slice(0, 5).forEach((c, i) => {
    const causes = ROOT_TRIGGERS.has(c.name) ? `called ×${c.commits.size}` : top(c.causes, 3) || 'props from above';
    const mounts = c.mounts ? `, ${c.mounts} mounts` : '';
    lines.push(
      `${i + 1}. ${c.name}: ${causes} → ${c.renders} renders in ${c.commits.size} commit(s) (${c.avoidable} avoidable${mounts}), ${ms(c.time)}`,
    );
    const affected = [...c.affected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (affected.length) lines.push(`   most affected: ${affected.map(([n, t]) => `${n} ${ms(t)}`).join(', ')}`);
    if (c.name === 'root.render()') {
      lines.push('   → root.render() re-renders the whole app from the top. Subscribe the components that need the data (useSyncExternalStore / a store hook) instead of calling root.render() again.');
    } else if (!ROOT_TRIGGERS.has(c.name) && c.renders >= 10 && c.avoidable / c.renders >= 0.5) {
      lines.push(`   → Most of this cascade is avoidable: move that state down into the component(s) that use it, pass unaffected subtrees as children, or memo the stable branches.`);
    }
  });
  return lines;
}

export function formatReport(commits, { sort = 'wasted', limit = 15, component } = {}) {
  if (!commits.length) return NO_DATA;
  let components = aggregate(commits);
  if (component) {
    const needle = component.toLowerCase();
    components = components.filter((c) => c.name.toLowerCase().includes(needle));
  }
  components.sort(SORTS[sort] ?? SORTS.wasted);

  const totalRenders = commits.reduce((n, c) => n + c.renders.length, 0);
  const totalAvoidable = components.reduce((n, c) => n + c.avoidable, 0);
  const avoidableMs = components.reduce((n, c) => n + c.avoidableSelf, 0);
  const span = (commits.at(-1).t - commits[0].t) / 1000;
  const triggers = new Map();
  for (const commit of commits) for (const u of commit.updaters ?? []) bump(triggers, u);

  const lines = [
    `Window: ${span.toFixed(1)}s, ${commits.length} commits, ${totalRenders} component renders` +
      ` — ${totalAvoidable} avoidable (${ms(avoidableMs)} self time wasted).`,
  ];
  if (triggers.size) lines.push(`State updates triggered by: ${top(triggers, 6)}`);
  if (!component) lines.push('', ...formatCascades(aggregateCascades(commits)));
  lines.push(
    'Legend: "same value" = new reference with identical contents (memoizable); "real change" = contents differ.',
    `Sorted by ${sort}. Showing ${Math.min(limit, components.length)} of ${components.length} components.`,
    '',
  );

  components.slice(0, limit).forEach((c, i) => {
    lines.push(...formatComponent(c, i + 1), '');
  });
  return lines.join('\n').trimEnd();
}

function formatComponent(c, rank) {
  const updates = c.renders - c.mounts;
  const owner = c.owners.size ? [...c.owners.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  const lines = [
    `${rank}. ${c.name}${c.memo ? ' (memo)' : ''} — ${c.renders} renders (${c.mounts} mounts, ${updates} re-renders) across ${c.instances.size} instance(s); ` +
      `self ${ms(c.self)} total, max ${ms(c.maxSelf)}; avoidable ${c.avoidable}/${updates}`,
  ];
  const where = [];
  if (owner) where.push(`rendered by ${owner}`);
  if (c.sites.size) where.push(`JSX at ${[...c.sites].join(', ')}`);
  if (where.length) lines.push(`   ${where.join('; ')}`);

  if (!updates) return lines;
  lines.push('   Why it re-rendered:');
  for (const p of sorted(c.props)) {
    lines.push(`   - prop \`${p.key}\` changed ${p.count}×${sameNote(p)}${origin(p)} — e.g. ${p.example}`);
  }
  for (const s of sorted(c.state)) {
    lines.push(`   - state (${s.key}) changed ${s.count}×${sameNote(s)} — e.g. ${s.example}`);
  }
  for (const x of sorted(c.context)) {
    lines.push(`   - context ${x.key} changed ${x.count}×${sameNote(x)}`);
  }
  if (c.causes.parent) {
    lines.push(`   - parent re-rendered, props unchanged ${c.causes.parent}×` + (c.origins.size ? ` (cascade from ${top(c.origins, 3)})` : ''));
  }

  const hints = suggest(c, owner);
  if (hints.length) {
    lines.push('   Fix ideas:');
    for (const h of hints) lines.push(`   → ${h}`);
  }
  return lines;
}

function suggest(c, owner) {
  const hints = [];
  for (const p of c.props.values()) {
    if (p.sameValue / p.count < 0.5) continue;
    const creator = p.createdIn ?? owner;
    const where = creator ? ` in ${creator}` : ' in the parent';
    if (p.kind === 'function') {
      hints.push(`\`${p.key}\` is a new function each render with the same code: wrap it in useCallback${where} (or move it out of render).`);
    } else if (p.kind === 'object' || p.kind === 'array') {
      hints.push(`\`${p.key}\` is a new ${p.kind} with the same contents each render: useMemo it${where}, or hoist it to a module constant if it never changes.`);
    } else if (p.kind === 'element') {
      hints.push(`\`${p.key}\` is freshly created JSX each render${where}; React.memo can't skip it unless that element is stable (useMemo the element, or lift the content).`);
    }
  }
  const unstable = [...c.props.values()].filter((p) => p.sameValue / p.count >= 0.5).map((p) => `\`${p.key}\``);
  if (c.memo && unstable.length) {
    hints.push(`${c.name} is memoized but memo is defeated by unstable props ${unstable.join(', ')}; stabilizing them makes memo work.`);
  } else if (!c.memo && unstable.length && unstable.length === c.props.size) {
    hints.push(`After stabilizing ${unstable.join(', ')}, wrap ${c.name} in React.memo so it can skip these renders.`);
  }
  if (c.causes.parent && !c.memo) {
    const origin = c.origins.size ? ` caused by ${top(c.origins, 1).replace(/ ×\d+$/, '')} re-rendering` : '';
    hints.push(`${c.causes.parent} render(s) had identical props${origin}: React.memo(${c.name}) would skip them, or move the state that changes lower so ${c.name} isn't under it.`);
  }
  for (const s of c.state.values()) {
    if (s.sameValue / s.count >= 0.5) {
      hints.push(`State (${s.key}) is being set to a new object/array with identical contents: skip the update when nothing changed (return the previous state in the updater).`);
    }
  }
  for (const x of c.context.values()) {
    if (x.sameValue / x.count >= 0.5) {
      hints.push(`Context ${x.key}'s Provider value is recreated with the same contents: useMemo the \`value\` passed to the Provider.`);
    } else {
      hints.push(`Context ${x.key} really changes and ${c.name} re-renders on every change: split the context, or read only what's needed in a smaller child.`);
    }
  }
  if (c.self > 0 && c.maxSelf >= 4) {
    hints.push(`A single render takes up to ${ms(c.maxSelf)} of its own time: look for expensive work in the render body (useMemo it, or virtualize long lists).`);
  }
  return hints;
}

export function formatComponentRenders(commits, name, limit = 20) {
  const needle = name.toLowerCase();
  const rows = [];
  for (const commit of commits) {
    for (const r of commit.renders) {
      if (r.name.toLowerCase() === needle) rows.push({ commit, r });
    }
  }
  if (!rows.length) {
    const partial = new Set();
    for (const commit of commits) for (const r of commit.renders) if (r.name.toLowerCase().includes(needle)) partial.add(r.name);
    return partial.size
      ? `No renders of "${name}". Did you mean: ${[...partial].slice(0, 10).join(', ')}?`
      : `No renders of "${name}" recorded.`;
  }
  const shown = rows.slice(-limit);
  const lines = [`${rows.length} renders of ${shown[0].r.name}; showing the last ${shown.length}:`, ''];
  for (const { commit, r } of shown) {
    const head = [
      `#${r.id}`,
      new Date(commit.t).toISOString().slice(11, 23),
      r.mount ? 'MOUNT' : r.avoidable ? 'AVOIDABLE' : 'needed',
      `self ${ms(r.self ?? 0)}`,
      r.parent ? `parent ${r.parent}` : null,
      r.owner && r.owner !== r.parent ? `owner ${r.owner}` : null,
      commit.updaters ? `commit triggered by ${commit.updaters.join(', ')}` : null,
    ].filter(Boolean);
    lines.push(head.join(' | '));
    for (const p of r.props ?? []) {
      lines.push(`    prop ${p.key}: ${describeExample(p)} (${p.sameValue ? 'same value' : 'real change'})${origin(p)}`);
    }
    for (const s of r.state ?? []) lines.push(`    state ${s.key}: ${describeExample(s)} (${s.sameValue ? 'same value' : 'real change'})`);
    for (const x of r.context ?? []) lines.push(`    context ${x.key}: ${x.prev} → ${x.next} (${x.sameValue ? 'same value' : 'real change'})`);
    if (r.parentOnly) lines.push(`    nothing changed — parent re-rendered${r.origin ? ` (cascade from ${r.origin})` : ''}`);
  }
  return lines.join('\n');
}

export function formatCommits(commits, limit = 30) {
  if (!commits.length) return NO_DATA;
  const shown = commits.slice(-limit);
  const lines = [`${commits.length} commits recorded; showing the last ${shown.length} (oldest first):`, ''];
  for (const c of shown) {
    const heaviest = [...c.renders].sort((a, b) => (b.self ?? 0) - (a.self ?? 0)).slice(0, 3);
    const avoidable = c.renders.filter((r) => r.avoidable).length;
    lines.push(
      `${new Date(c.t).toISOString().slice(11, 23)} | ${c.duration != null ? ms(c.duration) : '?'} | ` +
        `${c.renders.length + (c.truncated ?? 0)} renders (${avoidable} avoidable)` +
        (c.updaters ? ` | triggered by ${c.updaters.join(', ')}` : '') +
        ` | heaviest: ${heaviest.map((r) => `${r.name} ${ms(r.self ?? 0)}`).join(', ')}`,
    );
  }
  return lines.join('\n');
}

const NO_DATA =
  'No React commits recorded yet. Make sure the app is open in a browser from this Vite dev server, ' +
  'then interact with it (or ask the user to reproduce the slow interaction).';

function sorted(map) {
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function sameNote(entry) {
  if (entry.sameValue === entry.count) return ' (always same value)';
  if (entry.sameValue === 0) return ' (real change)';
  return ` (same value ${entry.sameValue}/${entry.count})`;
}

function top(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ×${v}`)
    .join(', ');
}

function ms(n) {
  return `${n.toFixed(n < 10 ? 2 : 1)}ms`;
}
