import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

export async function until(fn, label, timeout = 30000, interval = 50) {
  const end = performance.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (performance.now() >= end) throw new Error(`Timed out: ${label}`);
    await sleep(interval);
  }
}

export async function connect(url) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  let next = 0;
  const calls = new Map();
  const listeners = new Map();
  socket.addEventListener('message', ({ data }) => {
    const { id, method, params, result, error } = JSON.parse(data);
    if (id) {
      const call = calls.get(id);
      if (!call) return;
      calls.delete(id);
      call.finish(error ? new Error(`${call.method}: ${error.message}`) : null, result);
    } else {
      for (const fn of listeners.get(method) || []) fn(params);
    }
  });
  socket.addEventListener('close', () => {
    for (const { finish } of calls.values()) finish(new Error('Chrome disconnected'));
  });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method).delete(fn);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error('Chrome disconnected'));
    const id = ++next;
    const finish = (error, result) => {
      clearTimeout(timer);
      calls.delete(id);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`No CDP reply: ${method}`)), 90000);
    calls.set(id, { method, finish });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (fn, ...args) => {
    const expression = `(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`;
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  return { on, send, evaluate, close: () => socket.close() };
}
