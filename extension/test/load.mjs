// Loads the extension's classic scripts into a bare context, the way the browser runs them: no modules, one global.
import fs from 'node:fs';
import vm from 'node:vm';

export const EXT = new URL('../', import.meta.url);
export const read = (name) => fs.readFileSync(new URL(name, EXT), 'utf8');

export function context(globals = {}) {
  const ctx = vm.createContext({ URL, console, setTimeout, clearTimeout, ...globals });
  vm.runInContext(read('link.js'), ctx, { filename: 'link.js' });
  return ctx;
}
export const run = (ctx, name) => vm.runInContext(read(name), ctx, { filename: name });

// Lets every pending promise in the extension's code settle.
export const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
