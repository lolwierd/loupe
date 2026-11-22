import { parentPort } from 'node:worker_threads';
import { tokenize } from './highlight.mjs';

parentPort.on('message', async ({ text, lang }) => {
  try {
    parentPort.postMessage({ json: JSON.stringify(await tokenize(text, lang)) });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});
