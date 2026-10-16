import {statSync} from 'node:fs';

// Match adapter hot-loading: inspect/login fixes can be checked while keeping
// the user's existing browser and unfinished Council form alive.
export function loadAuth():Promise<typeof import('./auth.ts')> {
  const url=new URL('./auth.ts',import.meta.url);
  return import(`${url.href}?v=${statSync(url).mtimeMs}`);
}
