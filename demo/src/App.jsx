// Deliberately slow app: every pattern below is a known re-render problem.
import { createContext, memo, useContext, useState } from 'react';

const ThemeContext = createContext(null);
ThemeContext.displayName = 'ThemeContext';

const initialTodos = Array.from({ length: 50 }, (_, i) => ({ id: i, text: `Todo ${i}`, done: i % 3 === 0 }));

export function App() {
  // Problem: search text lives at the top, so typing re-renders everything.
  const [query, setQuery] = useState('');
  const [todos, setTodos] = useState(initialTodos);
  const [theme] = useState('light');

  return (
    // Problem: provider value is a new object on every render.
    <ThemeContext.Provider value={{ theme }}>
      <Header />
      <input id="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" />
      <TodoList
        todos={todos}
        query={query}
        // Problem: inline callback + inline object defeat memo(TodoItem).
        onToggle={(id) => setTodos((list) => list.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))}
        style={{ padding: 8 }}
      />
      <SlowStats todos={todos} />
    </ThemeContext.Provider>
  );
}

// Problem: no props, not memoized — re-renders whenever App does.
function Header() {
  const ctx = useContext(ThemeContext);
  return <h1 className={ctx.theme}>Todos</h1>;
}

function TodoList({ todos, query, onToggle, style }) {
  const visible = todos.filter((t) => t.text.toLowerCase().includes(query.toLowerCase()));
  return (
    <ul style={style}>
      {visible.map((t) => (
        <TodoItem key={t.id} todo={t} onToggle={onToggle} options={{ showId: true }} />
      ))}
    </ul>
  );
}

const TodoItem = memo(function TodoItem({ todo, onToggle, options }) {
  return (
    <li onClick={() => onToggle(todo.id)}>
      {options.showId ? `#${todo.id} ` : ''}
      {todo.text} {todo.done ? '✓' : ''}
    </li>
  );
});

// Problem: expensive render that only depends on todos, but re-renders on every keystroke.
function SlowStats({ todos }) {
  const start = performance.now();
  while (performance.now() - start < 6) {}
  return <p>{todos.filter((t) => t.done).length} done</p>;
}
