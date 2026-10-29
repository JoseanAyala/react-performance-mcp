// Injected into the page as a classic <script> in <head>, so it runs before React loads.
// Records every component render with the same "why did this render?" logic React DevTools
// uses (changed prop keys, changed stateful hooks, changed context, first mount), plus a
// value-equality check so wasted renders can be told apart from real ones.
// Placeholders (__ENDPOINT__) are filled in by the Vite plugin when this file is served.
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__REACT_PERF_MCP__) return;

  var ENDPOINT = '__ENDPOINT__';
  var FLUSH_MS = 250;
  var MAX_QUEUE = 2000;
  var MAX_RENDERS_PER_COMMIT = 300;
  var PREVIEW_LEN = 80;

  // Fiber work tags (stable since React 16.6; IncompleteFunctionComponent added in 19).
  var FunctionComponent = 0;
  var ClassComponent = 1;
  var IndeterminateComponent = 2;
  var HostRoot = 3;
  var ForwardRef = 11;
  var MemoComponent = 14;
  var SimpleMemoComponent = 15;
  var IncompleteClassComponent = 17;
  var IncompleteFunctionComponent = 28;
  var PerformedWork = 1;

  var sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var queue = [];
  var meta = { reactVersions: [] };
  var ids = new WeakMap();
  var nextId = 1;
  var jsxSiteCache = new Map();
  var lastError = null;

  var actions = [];
  var recording = !window.__REACT_PERF_MCP_REPLAY__;
  // Survives full page loads in the same tab, so multi-page flows stay one recording.
  var tab = getTabId();

  installHook();
  // Scripted scenario runs set the replay flag so replays aren't recorded as new user actions.
  if (recording) installRecorder();
  window.__REACT_PERF_MCP__ = { sessionId: sessionId, tabId: tab.id, flush: function () { return flush(true); } };
  setInterval(function () { flush(false); }, FLUSH_MS);
  window.addEventListener('pagehide', function () { flush(true); });

  function getTabId() {
    var KEY = '__react_perf_mcp_tab';
    try {
      var id = sessionStorage.getItem(KEY);
      if (id) return { id: id, continued: true };
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem(KEY, id);
      return { id: id, continued: false };
    } catch (e) {
      return { id: sessionId, continued: false };
    }
  }

  function installHook() {
    var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) {
      // Minimal DevTools hook. react-refresh and the DevTools extension wrap/replace
      // compatible hooks, so this coexists with both.
      var rendererId = 0;
      hook = {
        renderers: new Map(),
        supportsFiber: true,
        inject: function (renderer) {
          var id = ++rendererId;
          this.renderers.set(id, renderer);
          return id;
        },
        onScheduleFiberRoot: function () {},
        onCommitFiberRoot: function () {},
        onCommitFiberUnmount: function () {},
        onPostCommitFiberRoot: function () {},
        checkDCE: function () {},
      };
      Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: hook,
      });
    }

    var prevInject = hook.inject;
    hook.inject = function (renderer) {
      if (renderer && renderer.version) meta.reactVersions.push(renderer.version);
      return prevInject.apply(this, arguments);
    };
    if (hook.renderers) {
      hook.renderers.forEach(function (renderer) {
        if (renderer && renderer.version) meta.reactVersions.push(renderer.version);
      });
    }

    var prevCommit = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = function (rendererID, root) {
      try {
        handleCommit(root);
      } catch (error) {
        if (!lastError) console.warn('[react-performance-mcp] failed to record commit', error);
        lastError = String(error && error.stack || error);
      }
      return prevCommit ? prevCommit.apply(this, arguments) : undefined;
    };
  }

  // ---------------------------------------------------------------------------
  // Commit walking

  function handleCommit(root) {
    var hostRoot = root.current;
    var renders = [];
    walk(hostRoot.child, null, null, renders);
    if (renders.length === 0) return;

    var truncated = 0;
    if (renders.length > MAX_RENDERS_PER_COMMIT) {
      truncated = renders.length - MAX_RENDERS_PER_COMMIT;
      renders.sort(function (a, b) { return (b.self || 0) - (a.self || 0); });
      renders.length = MAX_RENDERS_PER_COMMIT;
    }

    // What scheduled this commit. An update scheduled on the root fiber itself means root.render()
    // was called; the first one is the initial render.
    var prevElement = hostRoot.alternate && hostRoot.alternate.memoizedState ? hostRoot.alternate.memoizedState.element : null;
    var element = hostRoot.memoizedState ? hostRoot.memoizedState.element : null;
    var rootLabel = prevElement ? 'root.render()' : 'initial render';
    var updaters = [];
    if (root.memoizedUpdaters) {
      root.memoizedUpdaters.forEach(function (fiber) {
        var name = fiber.tag === HostRoot ? rootLabel : getName(fiber);
        if (name && updaters.indexOf(name) === -1) updaters.push(name);
      });
    }
    if (element !== prevElement && updaters.indexOf(rootLabel) === -1) updaters.unshift(rootLabel);
    if (!updaters.length) updaters = null;

    queue.push({
      t: Date.now(),
      duration: typeof hostRoot.actualDuration === 'number' ? round(hostRoot.actualDuration) : null,
      updaters: updaters,
      truncated: truncated,
      renders: renders,
    });
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    if (recording) noteCommit();
  }

  // `origin` is the nearest ancestor that rendered for its own reason, so renders that
  // only happened because a parent rendered can be traced back to the real trigger.
  function walk(fiber, parentRec, origin, out) {
    while (fiber) {
      var alt = fiber.alternate;
      var rec = parentRec;
      var nextOrigin = origin;

      if (isComponent(fiber) && didRender(fiber, alt)) {
        rec = recordRender(fiber, alt, parentRec, origin);
        out.push(rec);
        if (rec.ownReason) nextOrigin = rec;
      }

      // Only descend into subtrees React actually touched this commit.
      if (fiber.child && (!alt || fiber.child !== alt.child)) {
        walk(fiber.child, rec, nextOrigin, out);
      }
      fiber = fiber.sibling;
    }
  }

  function isComponent(fiber) {
    switch (fiber.tag) {
      case FunctionComponent:
      case ClassComponent:
      case IndeterminateComponent:
      case ForwardRef:
      case SimpleMemoComponent:
      case IncompleteClassComponent:
      case IncompleteFunctionComponent:
        return true;
      default:
        // MemoComponent wraps the real component fiber, which is recorded instead.
        return false;
    }
  }

  function didRender(fiber, alt) {
    if (!alt) return true;
    var flags = typeof fiber.flags === 'number' ? fiber.flags : fiber.effectTag;
    return (flags & PerformedWork) === PerformedWork;
  }

  function recordRender(fiber, alt, parentRec, origin) {
    var rec = {
      id: getId(fiber),
      name: getName(fiber) || 'Anonymous',
      memo: isMemoized(fiber),
      owner: fiber._debugOwner ? getName(fiber._debugOwner) : null,
      parent: parentRec ? parentRec.name : null,
      at: getJsxSite(fiber),
      dur: typeof fiber.actualDuration === 'number' ? round(fiber.actualDuration) : null,
      self: selfDuration(fiber),
      mount: !alt,
    };
    // Mounts are caused by whatever made their parent render (or by the root render itself).
    if (!alt) {
      rec.ownReason = false;
      if (origin) rec.origin = origin.name;
      return rec;
    }

    var props = changedProps(alt.memoizedProps, fiber.memoizedProps);
    for (var i = 0; i < props.length; i++) {
      if (props[i].kind !== 'primitive') traceSource(props[i], fiber, fiber.memoizedProps[props[i].key]);
    }
    var state = fiber.tag === ClassComponent || fiber.tag === IncompleteClassComponent
      ? changedClassState(alt.memoizedState, fiber.memoizedState)
      : changedHooks(alt.memoizedState, fiber.memoizedState);
    var context = changedContext(alt, fiber);

    if (props.length) rec.props = props;
    if (state.length) rec.state = state;
    if (context.length) rec.context = context;

    // Only a state change is this component's own reason to render. Props come from the parent,
    // and a context value comes from whatever rendered the Provider above it.
    rec.ownReason = state.length > 0;
    if (!props.length && !state.length && !context.length) {
      rec.parentOnly = true;
      if (origin) rec.origin = origin.name;
    } else if (!rec.ownReason && origin) {
      rec.origin = origin.name;
    }

    // Avoidable: nothing this component depends on actually changed in value.
    rec.avoidable = every(props, isSameValue) && every(state, isSameValue) && every(context, isSameValue);
    return rec;
  }

  function selfDuration(fiber) {
    if (typeof fiber.actualDuration !== 'number') return null;
    var self = fiber.actualDuration;
    var child = fiber.child;
    while (child) {
      self -= child.actualDuration || 0;
      child = child.sibling;
    }
    return round(Math.max(0, self));
  }

  // ---------------------------------------------------------------------------
  // Change detection (mirrors react-devtools-shared DevToolsFiberChangeDetection)

  function changedProps(prev, next) {
    var out = [];
    if (prev === next || !prev || !next) return out;
    var keys = unionKeys(prev, next);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!Object.is(prev[key], next[key])) out.push(describeChange(key, prev[key], next[key]));
    }
    return out;
  }

  function changedClassState(prev, next) {
    var out = [];
    if (prev === next || !prev || !next || typeof prev !== 'object') return out;
    var keys = unionKeys(prev, next);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!Object.is(prev[key], next[key])) out.push(describeChange('this.state.' + key, prev[key], next[key]));
    }
    return out;
  }

  // Stateful hooks (useState, useReducer, useSyncExternalStore, useTransition, useActionState)
  // are the ones with an update queue. Index them per kind so "2nd useState" is greppable.
  function changedHooks(prevHook, nextHook) {
    var out = [];
    var counts = {};
    var index = 0;
    while (prevHook && nextHook) {
      var queue = nextHook.queue;
      if (queue && typeof queue === 'object' && ('lastRenderedReducer' in queue || 'getSnapshot' in queue)) {
        var kind = hookKind(queue);
        counts[kind] = (counts[kind] || 0) + 1;
        if (!Object.is(prevHook.memoizedState, nextHook.memoizedState)) {
          var change = describeChange(ordinal(counts[kind]) + ' ' + kind, prevHook.memoizedState, nextHook.memoizedState);
          change.hookIndex = index;
          out.push(change);
        }
      }
      prevHook = prevHook.next;
      nextHook = nextHook.next;
      index++;
    }
    return out;
  }

  function hookKind(queue) {
    if ('getSnapshot' in queue) return 'useSyncExternalStore';
    var reducer = queue.lastRenderedReducer;
    if (reducer && reducer.name === 'basicStateReducer') return 'useState';
    return 'useReducer';
  }

  function changedContext(prevFiber, nextFiber) {
    var out = [];
    var prev = prevFiber.dependencies && prevFiber.dependencies.firstContext;
    var next = nextFiber.dependencies && nextFiber.dependencies.firstContext;
    while (prev && next) {
      // Different order means a prop/state change altered which contexts are read.
      if (prev.context !== next.context) break;
      if (!Object.is(prev.memoizedValue, next.memoizedValue)) {
        out.push(describeChange(contextName(next.context), prev.memoizedValue, next.memoizedValue));
      }
      prev = prev.next;
      next = next.next;
    }
    return out;
  }

  function contextName(context) {
    if (!context) return 'Context';
    if (context.displayName) return context.displayName;
    if (context.Provider && context.Provider.displayName) return context.Provider.displayName;
    return 'Context (set .displayName to name it)';
  }

  // A prop value is often created higher up and passed down unchanged. Follow the owner
  // chain while the owner received the identical value as one of its own props, so the
  // fix lands where the value is actually created.
  function traceSource(change, fiber, value) {
    var owner = fiber._debugOwner;
    var via = [];
    for (var i = 0; owner && i < 25; i++) {
      var props = owner.memoizedProps;
      var key = props && typeof props === 'object' ? keyOf(props, value) : null;
      if (key === null) {
        change.createdIn = getName(owner) || owner.name || null;
        if (via.length) change.via = via;
        return;
      }
      via.push((getName(owner) || owner.name) + '.' + key);
      owner = owner._debugOwner;
    }
  }

  function keyOf(object, value) {
    var keys = Object.keys(object);
    for (var i = 0; i < keys.length; i++) if (object[keys[i]] === value) return keys[i];
    return null;
  }

  function describeChange(key, prev, next) {
    var equal = deepEqual(prev, next, 0, { budget: 2000 });
    var change = { key: key, prev: preview(prev), next: preview(next), sameValue: equal === true };
    if (equal === false && prev !== null && next !== null && typeof prev === 'object' && typeof next === 'object') {
      var diff = firstDiff(prev, next, '', 0, { budget: 2000 });
      if (diff) change.diff = diff;
    }
    if (typeof prev === 'function' && typeof next === 'function') {
      change.kind = 'function';
    } else if (isElement(prev) || isElement(next)) {
      change.kind = 'element';
    } else if (Array.isArray(next)) {
      change.kind = 'array';
    } else if (next !== null && typeof next === 'object') {
      change.kind = 'object';
    } else {
      change.kind = 'primitive';
    }
    if (equal === 'unknown') change.sameValue = null;
    return change;
  }

  function isSameValue(change) {
    return change.sameValue === true;
  }

  // Returns true, false, or 'unknown' if the budget ran out. Functions compare equal when
  // their source is identical (a fresh closure of the same code — the useCallback case).
  function deepEqual(a, b, depth, ctx) {
    if (Object.is(a, b)) return true;
    if (--ctx.budget <= 0 || depth > 6) return 'unknown';
    var ta = typeof a;
    if (ta !== typeof b) return false;
    if (ta === 'function') return safeSource(a) === safeSource(b);
    if (ta !== 'object' || a === null || b === null) return false;
    if (isElement(a) || isElement(b)) {
      if (!isElement(a) || !isElement(b) || a.type !== b.type || a.key !== b.key) return false;
      return deepEqual(a.props, b.props, depth + 1, ctx);
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (a instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof Map || a instanceof Set) {
      if (a.size !== b.size) return false;
      return deepEqual(Array.from(a), Array.from(b), depth + 1, ctx);
    }
    if (typeof Node !== 'undefined' && (a instanceof Node || b instanceof Node)) return false;
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    var result = true;
    for (var i = 0; i < ka.length; i++) {
      var key = ka[i];
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      var r = deepEqual(a[key], b[key], depth + 1, ctx);
      if (r === false) return false;
      if (r === 'unknown') result = 'unknown';
    }
    return result;
  }

  // First path where two values differ, e.g. "[10].done: false → true".
  function firstDiff(a, b, path, depth, ctx) {
    if (deepEqual(a, b, 0, { budget: 500 }) !== false) return null;
    var structured = a !== null && b !== null && typeof a === 'object' && typeof b === 'object' &&
      !isElement(a) && !isElement(b) && Array.isArray(a) === Array.isArray(b);
    if (!structured || depth > 5 || --ctx.budget <= 0) {
      return (path || '(value)') + ': ' + preview(a) + ' → ' + preview(b);
    }
    if (Array.isArray(a) && a.length !== b.length) {
      return (path ? path + '.' : '') + 'length: ' + a.length + ' → ' + b.length;
    }
    var keys = unionKeys(a, b);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var sub = Array.isArray(a) ? path + '[' + key + ']' : path + (path ? '.' : '') + key;
      var found = firstDiff(a[key], b[key], sub, depth + 1, ctx);
      if (found) return found;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Naming and location

  function getId(fiber) {
    var id = ids.get(fiber) || (fiber.alternate && ids.get(fiber.alternate));
    if (!id) id = nextId++;
    ids.set(fiber, id);
    if (fiber.alternate) ids.set(fiber.alternate, id);
    return id;
  }

  function getName(fiber) {
    var type = fiber.type;
    if (!type) return null;
    if (typeof type === 'function') return type.displayName || type.name || null;
    if (typeof type === 'string') return type;
    if (typeof type === 'object') {
      if (type.displayName) return type.displayName;
      if (type.render) return type.render.displayName || type.render.name || null; // forwardRef
      if (type.type) return getName({ type: type.type }); // memo
    }
    return null;
  }

  function isMemoized(fiber) {
    if (fiber.tag === SimpleMemoComponent) return true;
    return !!(fiber.return && fiber.return.tag === MemoComponent);
  }

  // Where the JSX for this element was written (in the owner's file). React <=18 exposes
  // _debugSource; React 19 exposes _debugStack (an Error captured at element creation).
  function getJsxSite(fiber) {
    var source = fiber._debugSource;
    if (source && source.fileName) return shortPath(source.fileName) + ':' + source.lineNumber;
    var stack = fiber._debugStack;
    if (!stack) return null;
    if (jsxSiteCache.has(stack)) return jsxSiteCache.get(stack);
    var site = null;
    try {
      var lines = String(stack.stack || '').split('\n');
      for (var i = 0; i < lines.length; i++) {
        var match = /(https?:\/\/[^\s)]+?):(\d+):\d+/.exec(lines[i]);
        if (!match) continue;
        var url = match[1];
        if (/node_modules|\/\.vite\/deps\/|\/@vite\/|\/@react-refresh|__react-perf/.test(url)) continue;
        site = shortPath(url);
        break;
      }
    } catch (e) {}
    jsxSiteCache.set(stack, site);
    return site;
  }

  function shortPath(url) {
    try {
      var path = new URL(url, location.href).pathname;
      return path.replace(/^\/@fs/, '');
    } catch (e) {
      return String(url).split('?')[0];
    }
  }

  // ---------------------------------------------------------------------------
  // Previews and helpers

  function preview(value) {
    try {
      if (value === undefined) return 'undefined';
      if (value === null) return 'null';
      if (typeof value === 'function') return 'ƒ ' + (value.name || 'anonymous') + '()';
      if (typeof value === 'string') return truncate(JSON.stringify(value));
      if (typeof value !== 'object') return String(value);
      if (isElement(value)) return '<' + elementName(value) + ' />';
      if (Array.isArray(value)) return 'Array(' + value.length + ')' + (value.length ? ' ' + truncate(JSON.stringify(value.slice(0, 3), safeReplacer())) : '');
      if (value instanceof Map) return 'Map(' + value.size + ')';
      if (value instanceof Set) return 'Set(' + value.size + ')';
      if (value instanceof Date) return value.toISOString();
      var keys = Object.keys(value);
      return truncate('{' + keys.slice(0, 8).join(', ') + (keys.length > 8 ? ', …' : '') + '} ' + JSON.stringify(value, safeReplacer()));
    } catch (e) {
      return Object.prototype.toString.call(value);
    }
  }

  function safeReplacer() {
    var seen = new WeakSet();
    return function (key, value) {
      if (typeof value === 'function') return 'ƒ';
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        if (isElement(value)) return '<' + elementName(value) + ' />';
        if (typeof Node !== 'undefined' && value instanceof Node) return '[' + value.nodeName + ']';
      }
      return value;
    };
  }

  function isElement(value) {
    return !!value && typeof value === 'object' && typeof value.$$typeof === 'symbol' && 'props' in value;
  }

  function elementName(element) {
    var type = element.type;
    if (typeof type === 'string') return type;
    return getName({ type: type }) || 'Component';
  }

  function safeSource(fn) {
    try {
      return Function.prototype.toString.call(fn);
    } catch (e) {
      return fn;
    }
  }

  function unionKeys(a, b) {
    var keys = Object.keys(a);
    var bKeys = Object.keys(b);
    for (var i = 0; i < bKeys.length; i++) if (!(bKeys[i] in a)) keys.push(bKeys[i]);
    return keys;
  }

  function every(list, fn) {
    for (var i = 0; i < list.length; i++) if (!fn(list[i])) return false;
    return true;
  }

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function truncate(text) {
    return text.length > PREVIEW_LEN ? text.slice(0, PREVIEW_LEN - 1) + '…' : text;
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  // ---------------------------------------------------------------------------
  // Interaction recorder: turns what the user does into replayable scenario steps
  // (Playwright selectors), so the agent can reproduce the exact interaction.

  var TEXT_INPUT = /^(text|search|email|url|tel|password|number|)$/;
  var NAMED_KEYS = /^(Enter|Escape|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|Delete|Backspace|F\d{1,2})$/;
  var CARET_KEYS = /^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|Tab|Escape)$/;
  var INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],' +
    '[role=option],[role=checkbox],[role=switch],[role=slider],[role=row],[draggable=true],[contenteditable=""],[contenteditable=true]';
  var PRESS_HANDLERS = ['onClick', 'onMouseDown', 'onPointerDown', 'onMouseUp', 'onPointerUp', 'onTouchStart'];
  var DRAG_HANDLERS = ['onMouseDown', 'onPointerDown', 'onTouchStart', 'onDragStart', 'onMouseMove', 'onPointerMove'];
  var HOVER_HANDLERS = ['onMouseEnter', 'onMouseOver', 'onPointerEnter', 'onPointerOver', 'onMouseMove', 'onPointerMove'];
  var MOVE_HANDLERS = ['onMouseMove', 'onPointerMove'];
  var POSITIONAL = 'input[type=range],canvas,svg,img,video,[role=slider]';
  var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  var valueAtFocus = new WeakMap();
  var pendingType = null; // typing run in an <input>/<textarea>
  var pendingEdit = null; // typing run in a contenteditable (rich-text editor)
  var pointer = null; // active primary-button press, for drags and long presses
  var lastPress = null; // last completed press, for click hold time
  var hover = null; // element under the pointer that has React hover handlers
  var html5Drag = null;
  var wheel = null;
  var lastInputT = 0; // last click/key/press/input: commits right after it aren't caused by hovering
  var lastUserScrollIntent = 0;
  var scrollTimers = new Map();
  var scrollStart = new Map();
  var scrollPos = new WeakMap();
  var lastWheelStep = null;
  var resizeTimer = null;
  var suppressClickUntil = 0;
  var historyStack = [location.href];
  var historyIndex = 0;
  var propsKey = null;
  var finishing = false;

  function installRecorder() {
    var opts = { capture: true, passive: true };
    var on = function (type, fn) { document.addEventListener(type, fn, opts); };
    on('focusin', onFocus);
    on('focusout', function () { commitType(); commitEdit(); });
    on('input', onInput);
    on('beforeinput', onBeforeInput);
    on('compositionend', onCompositionEnd);
    on('change', onChange);
    on('click', onClick);
    on('auxclick', onAuxClick);
    on('contextmenu', onContextMenu);
    on('dblclick', onDblClick);
    on('keydown', onKeyDown);
    on('scroll', onScroll);
    on('wheel', onWheel);
    on('pointerdown', onPointerDown);
    on('pointermove', onPointerMove);
    on('pointerup', onPointerUp);
    on('pointercancel', function () { pointer = null; });
    on('pointerover', onPointerOver);
    on('pointerout', onPointerOut);
    on('dragstart', onDragStart);
    on('drop', onDrop);
    on('dragend', function () { html5Drag = null; });
    window.addEventListener('touchmove', function () { lastUserScrollIntent = Date.now(); }, opts);
    window.addEventListener('resize', onResize, opts);
    window.addEventListener('popstate', onPopState, opts);
    patchHistory();
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    recordAction({ action: 'load', navType: nav ? nav.type : 'navigate', continued: tab.continued, viewport: { width: innerWidth, height: innerHeight } });
  }

  // Before every recorded action: finish in-progress typing/hover so steps stay in order.
  function recordAction(step, el) {
    if (!finishing && step.action !== 'hover' && step.action !== 'move') {
      finishing = true;
      finishHover();
      if (!step._typing) {
        commitType();
        commitEdit();
      }
      finishing = false;
    }
    delete step._typing;
    step.t = Date.now();
    step.path = location.pathname + location.search + location.hash;
    if (el) step._el = el;
    actions.push(step);
    if (actions.length > 1000) actions.splice(0, actions.length - 1000);
    return step;
  }

  // Called from handleCommit: lets the recorder attribute React work to hovers and drags.
  function noteCommit() {
    var now = Date.now();
    if (pointer) pointer.commits++;
    if (hover && now - lastInputT > 300 && (hover.moves || now - hover.t < 600)) hover.committed = true;
  }

  // ---- typing in inputs and textareas: minimal keystrokes that turn the old value into the new one

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TEXT_INPUT.test((el.getAttribute('type') || '').toLowerCase());
  }

  function editableRoot(el) {
    if (!el || el.nodeType !== 1 || !el.isContentEditable) return null;
    var root = el;
    while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
    return root;
  }

  function onFocus(e) {
    var el = realTarget(e);
    if (isTextField(el)) valueAtFocus.set(el, el.value);
  }

  function onInput(e) {
    if (!e.isTrusted) return;
    var el = realTarget(e);
    lastInputT = Date.now();
    if (editableRoot(el)) return; // handled via beforeinput
    if (!isTextField(el)) {
      if (el.tagName !== 'INPUT' || /^(checkbox|radio|file)$/i.test(el.type)) return;
      // Ranges dragged or clicked are replayed as that drag/click.
      if (pointer || (lastPress && lastPress.el === el && Date.now() - lastPress.upT < 300)) return;
      var last = actions[actions.length - 1];
      if (last && last.action === 'fill' && last._el === el) {
        last.text = el.value;
        return;
      }
      recordAction(withSelectors({ action: 'fill', text: el.value }, el), el);
      return;
    }
    var now = Date.now();
    if (pendingType && pendingType.el === el) {
      pendingType.value = el.value;
      pendingType.lastT = now;
      return;
    }
    commitType();
    pendingType = { el: el, initial: valueAtFocus.has(el) ? valueAtFocus.get(el) : '', value: el.value, t: now, lastT: now };
  }

  function commitType() {
    var p = pendingType;
    if (!p) return;
    pendingType = null;
    valueAtFocus.set(p.el, p.value);
    var a = p.initial;
    var b = p.value;
    if (a === b) return;
    var start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    var endA = a.length;
    var endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    var removed = endA - start;
    var inserted = b.slice(start, endB);
    var base = withSelectors({}, p.el);
    var steps = [];
    var atEnd = endA === a.length;
    if (atEnd && !removed) {
      steps.push(Object.assign({ action: 'type', text: inserted }, base));
    } else {
      // Mid-text edit: put the caret after the replaced range, delete it, type the replacement.
      steps.push(Object.assign({ action: 'caret', offset: endA }, base));
      if (removed) steps.push({ action: 'press', key: 'Backspace', repeat: removed });
      if (inserted) steps.push({ action: 'type', text: inserted });
    }
    for (var i = 0; i < steps.length; i++) {
      steps[i]._typing = true;
      recordAction(steps[i], p.el);
      steps[i].t = p.t;
      steps[i].end = p.lastT;
    }
  }

  // ---- rich-text editors (contenteditable): caret position + the exact edit operations

  function onBeforeInput(e) {
    if (!e.isTrusted) return;
    var root = editableRoot(realTarget(e));
    if (!root) return;
    var type = e.inputType || '';
    if (type === 'insertCompositionText' || type.indexOf('format') === 0 || type === 'historyUndo' || type === 'historyRedo') return;
    var edit = startEdit(root);
    if (type === 'insertText' || type === 'insertReplacementText') addEditText(edit, e.data || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '');
    else if (type === 'insertFromPaste' || type === 'insertFromDrop') addEditOp(edit, { paste: (e.dataTransfer && e.dataTransfer.getData('text/plain')) || e.data || '' });
    else if (type === 'insertParagraph') addEditKey(edit, 'Enter');
    else if (type === 'insertLineBreak') addEditKey(edit, 'Shift+Enter');
    else if (type === 'deleteContentBackward') addEditKey(edit, 'Backspace');
    else if (type === 'deleteContentForward') addEditKey(edit, 'Delete');
    else if (type === 'deleteWordBackward') addEditKey(edit, IS_MAC ? 'Alt+Backspace' : 'Control+Backspace');
    else if (type === 'deleteWordForward') addEditKey(edit, IS_MAC ? 'Alt+Delete' : 'Control+Delete');
  }

  function onCompositionEnd(e) {
    var root = editableRoot(realTarget(e));
    if (root && e.data) addEditText(startEdit(root), e.data);
  }

  function startEdit(root) {
    lastInputT = Date.now();
    if (pendingEdit && pendingEdit.root === root) return pendingEdit;
    finishing = true;
    finishHover();
    commitType();
    commitEdit();
    finishing = false;
    pendingEdit = { root: root, ops: [], t: Date.now(), lastT: Date.now(), caret: caretOffset(root) };
    return pendingEdit;
  }

  function addEditText(edit, text) {
    if (!text) return;
    var last = edit.ops[edit.ops.length - 1];
    if (last && last.text !== undefined) last.text += text;
    else edit.ops.push({ text: text });
    edit.lastT = Date.now();
  }

  function addEditKey(edit, key) {
    var last = edit.ops[edit.ops.length - 1];
    if (last && last.key === key) last.repeat = (last.repeat || 1) + 1;
    else edit.ops.push({ key: key });
    edit.lastT = Date.now();
  }

  function addEditOp(edit, op) {
    edit.ops.push(op);
    edit.lastT = Date.now();
  }

  function commitEdit() {
    var p = pendingEdit;
    if (!p) return;
    pendingEdit = null;
    if (!p.ops.length) return;
    var steps = [withSelectors({ action: 'caret', offset: p.caret === null ? -1 : p.caret }, p.root)];
    for (var i = 0; i < p.ops.length; i++) {
      var op = p.ops[i];
      if (op.text !== undefined) steps.push({ action: 'type', text: op.text });
      else if (op.paste !== undefined) steps.push({ action: 'insertText', text: op.paste });
      else steps.push(op.repeat > 1 ? { action: 'press', key: op.key, repeat: op.repeat } : { action: 'press', key: op.key });
    }
    for (var j = 0; j < steps.length; j++) {
      steps[j]._typing = true;
      recordAction(steps[j], p.root);
      steps[j].t = p.t;
      steps[j].end = p.lastT;
    }
  }

  // Caret position as a text offset within the editor (-1 = end).
  function caretOffset(root) {
    try {
      var sel = getSelection();
      if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return null;
      var range = document.createRange();
      range.selectNodeContents(root);
      range.setEnd(sel.anchorNode, sel.anchorOffset);
      return range.toString().length;
    } catch (e) {
      return null;
    }
  }

  // ---- selects, files

  // Untrusted change events are accepted for selects and file inputs: automation tools (and some
  // component libraries) set them programmatically, and apps rarely dispatch them on their own.
  function onChange(e) {
    var el = realTarget(e);
    if (!e.isTrusted && el.tagName !== 'SELECT' && !(el.tagName === 'INPUT' && el.type === 'file')) return;
    lastInputT = Date.now();
    if (el.tagName === 'SELECT' && !el.multiple) {
      recordAction(withSelectors({ action: 'select', value: el.value }, el), el);
    } else if (el.tagName === 'SELECT') {
      var values = Array.prototype.filter.call(el.options, function (o) { return o.selected; }).map(function (o) { return o.value; });
      recordAction(withSelectors({ action: 'select', values: values }, el), el);
    } else if (el.tagName === 'INPUT' && el.type === 'file') {
      recordAction(withSelectors({ action: 'upload', files: fileMeta(el.files) }, el), el);
    }
  }

  function fileMeta(files) {
    return Array.prototype.map.call(files || [], function (f) {
      return { name: f.name, type: f.type || 'application/octet-stream', size: f.size };
    });
  }

  // ---- clicks

  function onClick(e) {
    if (!e.isTrusted || e.button !== 0 || Date.now() < suppressClickUntil) return;
    var el = interactiveTarget(realTarget(e));
    if (!el || el.tagName === 'SELECT' || el.tagName === 'OPTION' || isTextField(el) || editableRoot(el)) return;
    var last = actions[actions.length - 1];
    // Keyboard-activated clicks (Enter/Space on a button) replay from the key press itself.
    if (e.detail === 0 && last && last.action === 'press' && Date.now() - last.t < 150) return;
    // Clicking a <label> also fires a click on its control; keep only the label click.
    if (last && last.action === 'click' && Date.now() - last.t < 100 && last._el && last._el.tagName === 'LABEL' && last._el.control === el) return;
    lastInputT = Date.now();
    if (hover && !hover.moves && (hover.el.contains(el) || el.contains(hover.el))) hover = null; // click hovers first anyway
    recordAction(clickStep(e, el, {}), el);
  }

  function onAuxClick(e) {
    if (!e.isTrusted || e.button !== 1) return;
    var el = interactiveTarget(realTarget(e));
    if (el) recordAction(clickStep(e, el, { button: 'middle' }), el);
  }

  function onContextMenu(e) {
    if (!e.isTrusted) return;
    lastInputT = Date.now();
    var el = interactiveTarget(realTarget(e));
    if (el) recordAction(clickStep(e, el, { button: 'right' }), el);
  }

  function onDblClick(e) {
    if (!e.isTrusted) return;
    var el = interactiveTarget(realTarget(e)) || realTarget(e);
    if (editableRoot(el)) return; // word selection in editors shows up as the following edit's caret
    for (var n = 0; n < 2; n++) {
      var last = actions[actions.length - 1];
      if (last && last.action === 'click' && last._el === el && Date.now() - last.t < 600) actions.pop();
    }
    recordAction(clickStep(e, el, { action: 'dblclick' }), el);
  }

  // Clicks on the page background (outside any element's box) are kept as viewport coordinates.
  function clickStep(e, el, extra) {
    var background = el === document.documentElement || el === document.body;
    var step = background ? { action: extra.action || 'click' } : withSelectors({ action: extra.action || 'click' }, el);
    if (extra.button) step.button = extra.button;
    var modifiers = [];
    if (e.altKey) modifiers.push('Alt');
    if (e.ctrlKey && extra.button !== 'right') modifiers.push('Control');
    if (e.metaKey) modifiers.push('Meta');
    if (e.shiftKey) modifiers.push('Shift');
    if (modifiers.length) step.modifiers = modifiers;
    // Where inside the element matters for sliders/canvases, and for clicks on plain containers
    // (e.g. clicking empty space to dismiss or blur), whose center may be some other widget.
    var plain = !el.matches(INTERACTIVE) && !reactHandler(el, PRESS_HANDLERS);
    if (background) step.position = { x: Math.round(e.clientX), y: Math.round(e.clientY) };
    else if (plain || el.matches(POSITIONAL) || el.closest('svg')) step.position = relativePoint(el, e.clientX, e.clientY);
    if (lastPress && lastPress.upT - lastPress.t > 350 && Date.now() - lastPress.upT < 100) step.delay = lastPress.upT - lastPress.t;
    return step;
  }

  function relativePoint(el, x, y) {
    var r = el.getBoundingClientRect();
    return { x: Math.round(x - r.left), y: Math.round(y - r.top) };
  }

  // ---- pointer drags (sortable lists, sliders, resizers, canvases) and long presses

  function onPointerDown(e) {
    if (!e.isTrusted || e.button !== 0) return;
    lastInputT = lastUserScrollIntent = Date.now();
    finishHover();
    commitType();
    commitEdit();
    pointer = { target: realTarget(e), x: e.clientX, y: e.clientY, t: Date.now(), points: [], moved: false, commits: 0, sampled: 0 };
  }

  function onPointerMove(e) {
    if (!e.isTrusted) return;
    var now = Date.now();
    if (pointer) {
      var dx = Math.round(e.clientX - pointer.x);
      var dy = Math.round(e.clientY - pointer.y);
      if (!pointer.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      pointer.moved = true;
      pointer.last = [dx, dy];
      if (now - pointer.sampled >= 30 && pointer.points.length < 80) {
        pointer.points.push([dx, dy]);
        pointer.sampled = now;
      }
      return;
    }
    if (hover && hover.moves && now - hover.sampled >= 40 && hover.moves.length < 60) {
      hover.moves.push([Math.round(e.clientX - hover.rect.left), Math.round(e.clientY - hover.rect.top)]);
      hover.sampled = now;
      hover.lastT = now;
    }
  }

  function onPointerUp(e) {
    var p = pointer;
    pointer = null;
    if (!p || !e.isTrusted) return;
    var target = interactiveTarget(p.target) || p.target;
    lastPress = { el: target, t: p.t, upT: Date.now() };
    if (!p.moved || html5Drag) return;
    var source = withHandlers(p.target, DRAG_HANDLERS) || (p.target.closest && p.target.closest('input[type=range],[role=slider],[draggable=true],canvas'));
    // Plain text selection drags don't matter unless React reacted to them.
    if (!source && !p.commits) return;
    var el = source || target;
    if (p.last && (!p.points.length || p.points[p.points.length - 1].join() !== p.last.join())) p.points.push(p.last);
    var step = withSelectors({ action: 'drag', from: relativePoint(el, p.x, p.y), points: p.points, duration: Date.now() - p.t }, el);
    var drop = deepElementFromPoint(e.clientX, e.clientY);
    if (drop && drop !== el && !el.contains(drop)) step.to = selectorsFor(interactiveTarget(drop) || drop)[0];
    recordAction(step, el).t = p.t;
    suppressClickUntil = Date.now() + 100;
  }

  function deepElementFromPoint(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      var inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // ---- HTML5 drag and drop, dropped files

  function onDragStart(e) {
    if (!e.isTrusted) return;
    var el = realTarget(e);
    var source = el.closest ? el.closest('[draggable=true]') || el : el;
    html5Drag = { el: source, t: Date.now(), selectors: selectorsFor(source) };
    pointer = null;
  }

  function onDrop(e) {
    if (!e.isTrusted) return;
    lastInputT = Date.now();
    var target = realTarget(e);
    var zone = withHandlers(target, ['onDrop', 'onDragOver']) || target;
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!html5Drag && files && files.length) {
      recordAction(withSelectors({ action: 'dropFiles', files: fileMeta(files) }, zone), zone);
      return;
    }
    if (!html5Drag) return;
    var step = { action: 'dragTo', selector: html5Drag.selectors[0], to: selectorsFor(zone)[0] };
    if (html5Drag.selectors.length > 1) step.fallbackSelectors = html5Drag.selectors.slice(1, 3);
    recordAction(step, html5Drag.el).t = html5Drag.t;
    html5Drag = null;
    suppressClickUntil = Date.now() + 100;
  }

  // ---- hovers that make React do work (menus, tooltips, prefetching, charts)

  function onPointerOver(e) {
    if (!e.isTrusted || e.pointerType === 'touch' || pointer) return;
    var el = withHandlers(realTarget(e), HOVER_HANDLERS);
    if (!el || (hover && hover.el === el)) return;
    finishHover();
    var tracksMoves = !!reactHandler(el, MOVE_HANDLERS);
    hover = { el: el, t: Date.now(), committed: false, moves: tracksMoves ? [] : null, rect: el.getBoundingClientRect(), sampled: 0 };
  }

  function onPointerOut(e) {
    if (hover && e.isTrusted && !(e.relatedTarget && hover.el.contains(e.relatedTarget))) {
      if (realTarget(e) === hover.el || !hover.el.contains(realTarget(e))) finishHover();
    }
  }

  function finishHover() {
    var h = hover;
    hover = null;
    if (!h || !h.committed || !h.el.isConnected) return;
    var step = h.moves && h.moves.length > 1
      ? withSelectors({ action: 'move', points: h.moves, duration: (h.lastT || Date.now()) - h.t }, h.el)
      : withSelectors({ action: 'hover' }, h.el);
    recordAction(step, h.el).t = h.t;
  }

  // ---- keyboard

  function onKeyDown(e) {
    if (!e.isTrusted || e.isComposing) return;
    var target = deepActiveElement();
    var combo = (e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1;
    var key = (e.ctrlKey ? 'Control+' : '') + (e.metaKey ? 'Meta+' : '') + (e.altKey ? 'Alt+' : '') +
      (e.shiftKey && (combo || e.key.length > 1) ? 'Shift+' : '') + (e.key === ' ' ? 'Space' : e.key);
    if (/^(Control|Meta|Alt|Shift|CapsLock)$/.test(e.key)) return;
    lastInputT = lastUserScrollIntent = Date.now();

    var root = editableRoot(target);
    if (root) {
      // Inside editors, caret moves and shortcuts are part of the edit sequence; text and
      // Enter/Backspace/Delete arrive through beforeinput.
      if (combo || CARET_KEYS.test(e.key)) addEditKey(startEdit(root), key);
      return;
    }
    if (isTextField(target)) {
      if (!combo && !NAMED_KEYS.test(e.key)) return; // characters arrive as input events
      if (!combo && (e.key === 'Backspace' || e.key === 'Delete')) return;
    } else if (e.repeat && !/^(Arrow|Page)/.test(e.key)) {
      return;
    }
    var last = actions[actions.length - 1];
    if (last && last.action === 'press' && last.key === key && (last._el || null) === (target || null) && Date.now() - last.t < 1000) {
      last.repeat = (last.repeat || 1) + 1;
      last.t = Date.now();
      return;
    }
    var step = { action: 'press', key: key };
    recordAction(target ? withSelectors(step, target) : step, target);
  }

  function deepActiveElement() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el && el !== document.body && el !== document.documentElement ? el : null;
  }

  // ---- scrolling and wheel

  function onWheel(e) {
    if (!e.isTrusted) return;
    lastUserScrollIntent = Date.now();
    var el = withHandlers(realTarget(e), ['onWheel']);
    if (!el) return;
    if (!wheel || wheel.el !== el || wheel.ctrl !== e.ctrlKey) {
      flushWheel();
      wheel = { el: el, dx: 0, dy: 0, ctrl: e.ctrlKey, t: Date.now(), position: relativePoint(el, e.clientX, e.clientY) };
    }
    var scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    wheel.dx += e.deltaX * scale;
    wheel.dy += e.deltaY * scale;
    clearTimeout(wheel.timer);
    wheel.timer = setTimeout(flushWheel, 200);
  }

  function flushWheel() {
    var w = wheel;
    wheel = null;
    if (!w) return;
    clearTimeout(w.timer);
    var step = withSelectors({ action: 'wheel', dx: Math.round(w.dx), dy: Math.round(w.dy), position: w.position }, w.el);
    if (w.ctrl) step.modifiers = ['Control'];
    recordAction(step, w.el).t = w.t;
    lastWheelStep = { el: w.el, t: Date.now() };
  }

  // Only user-driven scrolls (wheel, touch, keys, scrollbar drag); app-driven scrolls replay themselves.
  // Scroll events arrive after the position changed, so deltas are measured from the last known position.
  function onScroll(e) {
    var target = e.target === document ? document.scrollingElement || document.documentElement : e.target;
    if (!scrollStart.has(target)) {
      if (Date.now() - lastUserScrollIntent > 400) {
        scrollPos.set(target, { top: target.scrollTop, left: target.scrollLeft });
        return;
      }
      var known = scrollPos.get(target) || { top: 0, left: 0 };
      scrollStart.set(target, { top: known.top, left: known.left, t: Date.now() });
    }
    clearTimeout(scrollTimers.get(target));
    scrollTimers.set(target, setTimeout(function () {
      var start = scrollStart.get(target);
      scrollStart.delete(target);
      scrollTimers.delete(target);
      scrollPos.set(target, { top: target.scrollTop, left: target.scrollLeft });
      var dy = Math.round(target.scrollTop - start.top);
      var dx = Math.round(target.scrollLeft - start.left);
      if (!dx && !dy) return;
      // A recorded wheel step on this element already reproduces this scroll.
      if (lastWheelStep && Date.now() - lastWheelStep.t < 600 && (lastWheelStep.el.contains(target) || target.contains(lastWheelStep.el))) return;
      var isPage = target === document.scrollingElement || target === document.documentElement || target === document.body;
      var step = { action: 'scroll', y: dy };
      if (dx) step.x = dx;
      recordAction(isPage ? step : withSelectors(step, target), target).t = start.t;
    }, 200));
  }

  // ---- window size and navigation

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var last = actions[actions.length - 1];
      if (last && last.action === 'resize') actions.pop();
      recordAction({ action: 'resize', width: innerWidth, height: innerHeight });
    }, 300);
  }

  function patchHistory() {
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name];
      history[name] = function () {
        var result = original.apply(this, arguments);
        if (name === 'pushState') {
          historyStack = historyStack.slice(0, historyIndex + 1);
          historyStack.push(location.href);
          historyIndex = historyStack.length - 1;
        } else {
          historyStack[historyIndex] = location.href;
        }
        return result;
      };
    });
  }

  // Browser back/forward buttons. History moves the app makes itself replay from the click that caused them.
  function onPopState() {
    var url = location.href;
    var direction = historyStack[historyIndex - 1] === url ? -1 : historyStack[historyIndex + 1] === url ? 1 : 0;
    if (direction) historyIndex += direction;
    if (Date.now() - lastInputT < 300) return;
    if (direction) recordAction({ action: direction < 0 ? 'back' : 'forward' });
    else recordAction({ action: 'goto', url: location.pathname + location.search + location.hash });
  }

  // ---- React and DOM helpers

  function realTarget(e) {
    var path = e.composedPath && e.composedPath();
    var node = path && path.length ? path[0] : e.target;
    return node && node.nodeType === 1 ? node : node && node.parentElement;
  }

  function composedParent(el) {
    if (el.parentElement) return el.parentElement;
    var root = el.getRootNode && el.getRootNode();
    return root && root.host ? root.host : null;
  }

  function reactProps(el) {
    if (!propsKey) {
      for (var key in el) {
        if (key.indexOf('__reactProps$') === 0) {
          propsKey = key;
          break;
        }
      }
    }
    return propsKey ? el[propsKey] : null;
  }

  function reactHandler(el, names) {
    var props = reactProps(el);
    if (!props) return null;
    for (var i = 0; i < names.length; i++) if (typeof props[names[i]] === 'function') return names[i];
    return null;
  }

  function withHandlers(node, names) {
    for (var el = node, i = 0; el && el.nodeType === 1 && el !== document.body && i < 10; el = composedParent(el), i++) {
      if (reactHandler(el, names)) return el;
    }
    return null;
  }

  function interactiveTarget(node) {
    for (var el = node, i = 0; el && el.nodeType === 1 && el !== document.body && i < 12; el = composedParent(el), i++) {
      if (el.matches(INTERACTIVE) || reactHandler(el, PRESS_HANDLERS)) return el;
    }
    return node && node.nodeType === 1 ? node : null;
  }

  // ---- selectors (Playwright syntax; `host >> inner` for shadow DOM)

  function withSelectors(step, el) {
    var list = selectorsFor(el);
    step.selector = list[0];
    if (list.length > 1) step.fallbackSelectors = list.slice(1, 3);
    return step;
  }

  function selectorsFor(el) {
    if (el === document.documentElement || el === document.body) return ['body'];
    var root = el.getRootNode ? el.getRootNode() : document;
    if (root && root.host) {
      var host = selectorsFor(root.host)[0];
      return selectorsWithin(el, root).map(function (s) { return host + ' >> ' + s; });
    }
    return selectorsWithin(el, document);
  }

  // Most readable unique selector first; a positional one last as a fallback for changing data.
  function selectorsWithin(el, scope) {
    var out = [];
    var tag = el.tagName.toLowerCase();
    var attrs = ['data-testid', 'data-test', 'data-cy', 'data-test-id'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (v) pushIfUnique(out, '[' + attrs[i] + '=' + JSON.stringify(v) + ']', el, scope);
    }
    if (stableId(el.id)) pushIfUnique(out, '#' + cssEscape(el.id), el, scope);
    var named = ['name', 'aria-label', 'placeholder', 'title', 'alt'];
    for (i = 0; i < named.length; i++) {
      v = el.getAttribute(named[i]);
      if (v && v.length < 60) pushIfUnique(out, tag + '[' + named[i] + '=' + JSON.stringify(v) + ']', el, scope);
    }
    var texts = candidateTexts(el);
    for (i = 0; i < texts.length && out.length < 2; i++) {
      if (countWithText(scope, tag, texts[i]) === 1) out.push(tag + ':has-text(' + JSON.stringify(texts[i]) + ')');
    }
    var path = cssPath(el, true);
    if (!out.length && unique(path, el, scope)) out.push(path);
    var generic = cssPath(el, false);
    var matches = queryAll(scope, generic);
    var index = matches.indexOf(el);
    if (index >= 0) out.push(matches.length === 1 ? generic : generic + ' >> nth=' + index);
    if (!out.length) out.push(path);
    return out;
  }

  function stableId(id) {
    return !!id && !/[:\s]/.test(id) && !/^\d/.test(id) && !/\d{4,}/.test(id);
  }

  function pushIfUnique(out, selector, el, scope) {
    if (out.indexOf(selector) === -1 && unique(selector, el, scope)) out.push(selector);
  }

  function unique(selector, el, scope) {
    var found = queryAll(scope, selector);
    return found.length === 1 && found[0] === el;
  }

  function queryAll(scope, selector) {
    try {
      return Array.prototype.slice.call(scope.querySelectorAll(selector));
    } catch (e) {
      return [];
    }
  }

  function normalize(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  // The element's own short text, then short texts of its children (e.g. a row's id cell).
  function candidateTexts(el) {
    var out = [];
    if (el.isContentEditable) return out;
    var own = normalize(el.innerText || el.textContent);
    if (own && own.length <= 40) out.push(own);
    var children = el.querySelectorAll('*');
    for (var i = 0; i < children.length && out.length < 8; i++) {
      if (children[i].children.length) continue;
      var t = normalize(children[i].textContent);
      if (t && t.length >= 2 && t.length <= 30 && out.indexOf(t) === -1) out.push(t);
    }
    return out;
  }

  // Mirrors Playwright's :has-text — case-insensitive substring of the element's text.
  function countWithText(scope, tag, text) {
    var needle = text.toLowerCase();
    var all = queryAll(scope, tag);
    var n = 0;
    for (var i = 0; i < all.length; i++) {
      if (normalize(all[i].innerText || all[i].textContent).toLowerCase().indexOf(needle) !== -1) n++;
    }
    return n;
  }

  // Path up to the nearest ancestor with an id/test id. `indexed` adds :nth-of-type to every
  // segment; otherwise only ancestors are indexed, so the result matches the element's siblings too.
  function cssPath(el, indexed) {
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && node !== document.documentElement && depth < 8; depth++) {
      var anchor = node.getAttribute('data-testid') ? '[data-testid=' + JSON.stringify(node.getAttribute('data-testid')) + ']'
        : stableId(node.id) ? '#' + cssEscape(node.id) : null;
      if (anchor && node !== el) {
        parts.unshift(anchor);
        break;
      }
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent && (indexed || node !== el)) {
        var same = 0;
        var position = 0;
        for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
          if (c.tagName === node.tagName) {
            same++;
            if (c === node) position = same;
          }
        }
        if (same > 1) part += ':nth-of-type(' + position + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&');
  }
  // ---------------------------------------------------------------------------
  // Transport

  // Returns a promise so scripted runs can wait until their commits reach the server.
  // Typing in progress is only committed once the user pauses (or on `force`).
  function flush(force) {
    var now = Date.now();
    if (pendingType && (force || now - pendingType.lastT > 1000)) commitType();
    if (pendingEdit && (force || now - pendingEdit.lastT > 1000)) commitEdit();
    if (hover && hover.committed && (force || now - (hover.lastT || hover.t) > 1000)) finishHover();
    if (!queue.length && !actions.length) return Promise.resolve();
    var commits = queue;
    queue = [];
    var recorded = actions.map(function (a) {
      var copy = {};
      for (var k in a) if (k !== '_el') copy[k] = a[k];
      return copy;
    });
    actions = [];
    var body = JSON.stringify({
      sessionId: sessionId,
      tabId: tab.id,
      url: location.href,
      title: document.title,
      reactVersions: meta.reactVersions,
      error: lastError,
      commits: commits,
      actions: recorded,
    });
    try {
      return fetch(ENDPOINT + '/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: body.length < 60000,
      }).then(function () {}, function () {});
    } catch (e) {
      return Promise.resolve();
    }
  }
})();
