import { useState } from 'react';
import { createRoot } from 'react-dom/client';

function Page2() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <button id="inc" onClick={() => setCount((c) => c + 1)}>Increment</button>
      <output id="state">p2={count}</output>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Page2 />);
