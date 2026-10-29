import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { currentUser, orders } from './data.js';

const AppContext = createContext(null);
AppContext.displayName = 'AppContext';

const COLUMNS = ['id', 'customer', 'product', 'status', 'amount', 'date'];
const FORMATTERS = { amount: (v) => `$${v.toFixed(2)}` };

export function App() {
  const [theme, setTheme] = useState('light');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [selectedId, setSelectedId] = useState(null);

  const filtered = useMemo(
    () =>
      orders.filter(
        (o) =>
          (status === 'all' || o.status === status) &&
          (o.customer.toLowerCase().includes(search.toLowerCase()) || String(o.id).includes(search)),
      ),
    [search, status],
  );
  const selected = orders.find((o) => o.id === selectedId) ?? null;

  const context = useMemo(() => ({ user: currentUser, theme, setTheme }), [theme]);
  const toggleTheme = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), []);
  const onSearch = useCallback((e) => setSearch(e.target.value), []);
  const onStatus = useCallback((e) => setStatus(e.target.value), []);
  const clearSelection = useCallback(() => setSelectedId(null), []);

  return (
    <AppContext.Provider value={context}>
      <div className={`layout ${theme}`}>
        <Sidebar />
        <main>
          <TopBar onToggleTheme={toggleTheme} />
          <FilterBar search={search} status={status} onSearch={onSearch} onStatus={onStatus} />
          <section className="cards">
            <StatsCards orders={filtered} />
            <RevenueChart orders={filtered} />
          </section>
          <div className="content">
            <OrdersTable
              orders={filtered}
              columns={COLUMNS}
              formatters={FORMATTERS}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            {selected && <OrderDetails order={selected} onClose={clearSelection} />}
          </div>
        </main>
      </div>
    </AppContext.Provider>
  );
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Sidebar() {
  const { user } = useContext(AppContext);
  return (
    <aside className="sidebar">
      <div className="brand">Northwind</div>
      <nav>
        {['Dashboard', 'Orders', 'Customers', 'Products', 'Reports', 'Settings'].map((item) => (
          <a key={item} className={item === 'Orders' ? 'active' : ''} href="#">
            {item}
          </a>
        ))}
      </nav>
      <div className="user">
        <strong>{user.name}</strong>
        <span>{user.role}</span>
      </div>
    </aside>
  );
}

function TopBar({ onToggleTheme }) {
  const { theme } = useContext(AppContext);
  const now = useNow();
  return (
    <header className="topbar">
      <h1>Orders</h1>
      <div className="topbar-right">
        <span className="clock">{now.toLocaleTimeString()}</span>
        <button onClick={onToggleTheme}>{theme === 'light' ? 'Dark' : 'Light'} mode</button>
      </div>
    </header>
  );
}

function FilterBar({ search, status, onSearch, onStatus }) {
  return (
    <div className="filters">
      <input id="search" value={search} onChange={onSearch} placeholder="Search customer or order #" />
      <select id="status" value={status} onChange={onStatus}>
        <option value="all">All statuses</option>
        <option value="pending">Pending</option>
        <option value="paid">Paid</option>
        <option value="shipped">Shipped</option>
        <option value="refunded">Refunded</option>
      </select>
    </div>
  );
}

const StatsCards = memo(function StatsCards({ orders }) {
  const revenue = orders.filter((o) => o.status !== 'refunded').reduce((sum, o) => sum + o.amount, 0);
  const amounts = orders.map((o) => o.amount).sort((a, b) => a - b);
  const median = percentile(amounts, 0.5);
  const p95 = percentile(amounts, 0.95);
  const topCustomer = rankCustomers(orders)[0];

  return (
    <>
      <Card label="Revenue" value={`$${revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
      <Card label="Orders" value={orders.length} />
      <Card label="Median order" value={`$${median.toFixed(2)}`} />
      <Card label="P95 order" value={`$${p95.toFixed(2)}`} />
      <Card label="Top customer" value={topCustomer ? topCustomer[0] : '—'} />
    </>
  );
});

function Card({ label, value }) {
  return (
    <div className="card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const RevenueChart = memo(function RevenueChart({ orders }) {
  const byDay = new Map();
  for (const o of orders) byDay.set(o.date, (byDay.get(o.date) ?? 0) + o.amount);
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const points = smooth(days.map(([, v]) => v), 2);
  const max = Math.max(1, ...points);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / Math.max(1, points.length - 1)) * 300},${80 - (v / max) * 70}`).join(' ');

  return (
    <div className="card chart">
      <span>Revenue by day</span>
      <svg viewBox="0 0 300 80" preserveAspectRatio="none">
        <path d={d} fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
    </div>
  );
});

const OrdersTable = memo(function OrdersTable({ orders, columns, formatters, selectedId, onSelect }) {
  return (
    <table className="orders">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <OrderRow
            key={order.id}
            order={order}
            columns={columns}
            formatters={formatters}
            selected={order.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </tbody>
    </table>
  );
});

const OrderRow = memo(function OrderRow({ order, columns, formatters, selected, onSelect }) {
  return (
    <tr className={selected ? 'selected' : ''} onClick={() => onSelect(order.id)}>
      {columns.map((c) => (
        <td key={c} className={c === 'status' ? `status ${order.status}` : ''}>
          {formatters[c] ? formatters[c](order[c]) : order[c]}
        </td>
      ))}
    </tr>
  );
});

function OrderDetails({ order, onClose }) {
  return (
    <aside className="details">
      <button className="close" onClick={onClose}>×</button>
      <h2>Order #{order.id}</h2>
      <dl>
        <dt>Customer</dt>
        <dd>{order.customer}</dd>
        <dt>Product</dt>
        <dd>{order.product}</dd>
        <dt>Status</dt>
        <dd className={`status ${order.status}`}>{order.status}</dd>
        <dt>Amount</dt>
        <dd>${order.amount.toFixed(2)}</dd>
        <dt>Date</dt>
        <dd>{order.date}</dd>
      </dl>
    </aside>
  );
}

// Expects values sorted ascending.
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function rankCustomers(list) {
  const totals = {};
  for (const o of list) totals[o.customer] = (totals[o.customer] ?? 0) + o.amount;
  return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}

function smooth(values, passes) {
  let out = values;
  for (let p = 0; p < passes; p++) {
    const next = [];
    for (let i = 0; i < out.length; i++) {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(out.length - 1, i + 1); j++) {
        sum += out[j];
        n++;
      }
      next.push(sum / n);
    }
    out = next;
  }
  return out;
}
