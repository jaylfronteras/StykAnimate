import {readFile} from 'node:fs/promises';

/** Node's fetch does not read file: URLs. The app loads its bundled font that way. */
const nativeFetch = globalThis.fetch?.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = input instanceof URL ? input : new URL(String(input), import.meta.url);
  if (url.protocol === 'file:') {
    const data = await readFile(url);
    return new Response(data);
  }
  if (!nativeFetch) throw new Error('fetch is not available in this runtime.');
  return nativeFetch(input, init);
};
