// One widget per interaction type the recorder must capture. The <output id="state"> line
// summarizes everything, so a replay can be checked against the user's final state.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

class LabWidget extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<button part="button">Shadow press</button>';
    root.querySelector('button').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('lab-press', { bubbles: true, composed: true }));
    });
  }
}
customElements.define('lab-widget', LabWidget);

const tabFromUrl = () => new URLSearchParams(location.search).get('tab') ?? 'a';

function Lab() {
  const [menu, setMenu] = useState('closed');
  const [point, setPoint] = useState(-1);
  const [order, setOrder] = useState(['a', 'b', 'c', 'd']);
  const [zone, setZone] = useState([]);
  const [text, setText] = useState('hello world');
  const [editor, setEditor] = useState('');
  const [keys, setKeys] = useState(0);
  const [ctx, setCtx] = useState(0);
  const [middle, setMiddle] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [width, setWidth] = useState(innerWidth > 1000 ? 'wide' : 'narrow');
  const [scrolled, setScrolled] = useState(false);
  const [held, setHeld] = useState('none');
  const [shadow, setShadow] = useState(0);
  const [tab, setTab] = useState(tabFromUrl);
  const [files, setFiles] = useState('');
  const [color, setColor] = useState('red');
  const [checked, setChecked] = useState(false);
  const [range, setRange] = useState(50);
  const [dbl, setDbl] = useState(0);
  const [mods, setMods] = useState('');
  const dragging = useRef(null);
  const pressStart = useRef(0);
  const widget = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'j' && e.target === document.body) setKeys((k) => k + 1);
    };
    const onResize = () => setWidth(innerWidth > 1000 ? 'wide' : 'narrow');
    const onPop = () => setTab(tabFromUrl());
    const onPress = () => setShadow((s) => s + 1);
    const el = widget.current;
    addEventListener('keydown', onKey);
    addEventListener('resize', onResize);
    addEventListener('popstate', onPop);
    el.addEventListener('lab-press', onPress);
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      removeEventListener('popstate', onPop);
      el.removeEventListener('lab-press', onPress);
    };
  }, []);

  const goTab = (next) => {
    history.pushState(null, '', `?tab=${next}`);
    setTab(next);
  };

  const onRowDown = (id) => (e) => {
    dragging.current = { id, startY: e.clientY };
    const onUp = (up) => {
      const moved = Math.round((up.clientY - dragging.current.startY) / 30);
      setOrder((list) => {
        const from = list.indexOf(id);
        const to = Math.max(0, Math.min(list.length - 1, from + moved));
        const next = list.filter((x) => x !== id);
        next.splice(to, 0, id);
        return next;
      });
      dragging.current = null;
      removeEventListener('pointerup', onUp);
    };
    addEventListener('pointerup', onUp);
  };

  const state = [
    `menu=${menu}`, `point=${point}`, `order=${order.join('')}`, `zone=${zone.join('')}`, `text=${text}`,
    `editor=${editor}`, `keys=${keys}`, `ctx=${ctx}`, `middle=${middle}`, `zoom=${zoom}`, `width=${width}`,
    `scrolled=${scrolled}`, `held=${held}`, `shadow=${shadow}`, `tab=${tab}`, `files=${files}`, `color=${color}`,
    `checked=${checked}`, `range=${range}`, `dbl=${dbl}`, `mods=${mods}`,
  ].join('|');

  return (
    <main style={{ fontFamily: 'sans-serif', padding: 16, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(3, 320px)' }}>
      <div id="menu" onMouseEnter={() => setMenu('open')} style={{ padding: 8, background: '#eee' }}>Hover menu {menu}</div>

      <svg id="chart" width="300" height="60" onMouseMove={(e) => setPoint(Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / 30))}>
        <rect width="300" height="60" fill="#dde" />
      </svg>

      <ul id="sortable" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {order.map((id) => (
          <li key={id} data-testid={`row-${id}`} onPointerDown={onRowDown(id)} style={{ height: 30, background: '#f4f4f4', userSelect: 'none' }}>
            Row {id}
          </li>
        ))}
      </ul>

      <div>
        {['x', 'y'].filter((id) => !zone.includes(id)).map((id) => (
          <span key={id} id={`card-${id}`} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', id)} style={{ padding: 8, background: '#ffd' }}>
            Card {id}
          </span>
        ))}
        <div id="zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => setZone((z) => [...z, e.dataTransfer.getData('text/plain')])} style={{ padding: 16, background: '#dfd' }}>
          Drop zone
        </div>
      </div>

      <input id="text" value={text} onChange={(e) => setText(e.target.value)} />

      <div id="editor" contentEditable suppressContentEditableWarning onInput={(e) => setEditor(e.currentTarget.textContent)} style={{ border: '1px solid #999', minHeight: 40 }} />

      <div id="ctx" onContextMenu={(e) => { e.preventDefault(); setCtx((c) => c + 1); }} onAuxClick={(e) => e.button === 1 && setMiddle((m) => m + 1)} style={{ padding: 8, background: '#fde' }}>
        Right or middle click
      </div>

      <div id="zoomable" onWheel={(e) => e.ctrlKey && setZoom((z) => z + (e.deltaY < 0 ? 1 : -1))} style={{ padding: 8, background: '#def' }}>Ctrl+wheel zoom {zoom}</div>

      <div id="scroller" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 100)} style={{ height: 80, overflow: 'auto', background: '#eef' }}>
        <div style={{ height: 600 }}>Scroll me</div>
      </div>

      <button id="hold" onPointerDown={() => (pressStart.current = Date.now())} onPointerUp={() => setHeld(Date.now() - pressStart.current > 500 ? 'long' : 'short')}>
        Hold me
      </button>

      <lab-widget ref={widget} />

      <nav>
        <button id="tab-a" onClick={() => goTab('a')}>Tab A</button>
        <button id="tab-b" onClick={() => goTab('b')}>Tab B</button>
      </nav>

      <input id="file" type="file" multiple onChange={(e) => setFiles([...e.target.files].map((f) => `${f.name}:${f.size}`).join(','))} />

      <select id="color" value={color} onChange={(e) => setColor(e.target.value)}>
        <option value="red">Red</option>
        <option value="green">Green</option>
        <option value="blue">Blue</option>
      </select>

      <label>
        <input id="check" type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> Check me
      </label>

      <input id="range" type="range" min="0" max="100" value={range} onChange={(e) => setRange(Number(e.target.value))} style={{ width: 200 }} />

      <button id="dbl" onDoubleClick={() => setDbl((d) => d + 1)}>Double click</button>

      <button id="mods" onClick={(e) => setMods(`${e.shiftKey ? 'S' : ''}${e.altKey ? 'A' : ''}`)}>Modifier click</button>

      <a id="next" href="/page2.html">Page 2</a>

      <output id="state" style={{ gridColumn: '1 / -1', fontFamily: 'monospace', fontSize: 11 }}>{state}</output>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Lab />);
