/** File-system helpers for the Node-only parts (the CLI and its setup), kept out of util.ts, which browsers load too. */
import { realpathSync } from 'node:fs';

/** `p` with every symlink resolved, or null if there's nothing there. */
export function realPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
