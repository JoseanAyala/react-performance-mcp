// Anti-pattern under test: an external store that calls root.render() on every change,
// plus a root Provider whose value is recreated each render.
import { createContext, useContext, useState } from 'react';
import { createRoot } from 'react-dom/client';

const Settings = createContext(null);
Settings.displayName = 'SettingsContext';
let store = { count: 0 };
const root = createRoot(document.getElementById('root'));

function App({ count }) {
  const [theme, setTheme] = useState('light');
  return (
    <Settings.Provider value={{ theme }}>
      <output id="count">count={count}</output>
      <button id="theme" onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>Theme</button>
      <List />
    </Settings.Provider>
  );
}

function List() {
  return (
    <ul>
      {Array.from({ length: 30 }, (_, i) => (
        <Item key={i} i={i} />
      ))}
    </ul>
  );
}

function Item({ i }) {
  const { theme } = useContext(Settings);
  return <li className={theme}>Item {i}</li>;
}

const render = () => root.render(<App count={store.count} />);
document.getElementById('external').addEventListener('click', () => {
  store = { count: store.count + 1 };
  render();
});
render();
