// Deterministic fake data so reports are reproducible.
const customers = ['Acme Corp', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Industries', 'Wayne Enterprises', 'Soylent', 'Tyrell', 'Cyberdyne'];
const products = ['Widget Pro', 'Gadget Mini', 'Sprocket XL', 'Gizmo Max', 'Doohickey', 'Thingamajig'];
const statuses = ['pending', 'paid', 'shipped', 'refunded'];

let seed = 42;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

export const orders = Array.from({ length: 400 }, (_, i) => ({
  id: 10000 + i,
  customer: customers[Math.floor(random() * customers.length)],
  product: products[Math.floor(random() * products.length)],
  status: statuses[Math.floor(random() * statuses.length)],
  amount: Math.round(random() * 200000) / 100,
  date: new Date(2026, 9, 1 + Math.floor(random() * 27)).toISOString().slice(0, 10),
}));

export const currentUser = { name: 'Dana Reyes', role: 'Ops lead' };
