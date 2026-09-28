/** The services `yea mcp` exposes, kept in ~/.yea/services.json: `yea add/remove/services`. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../home.js';

const servicesFile = () => join(home(), 'services.json');

export function listServices(): string[] {
  try {
    const v = JSON.parse(readFileSync(servicesFile(), 'utf8'));

    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveServices(urls: string[]) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(
    servicesFile(),
    `${JSON.stringify([...new Set(urls)], null, 2)}\n`,
  );
}

export const addService = (url: string) =>
  saveServices([...listServices(), url]);

export const removeService = (url: string) =>
  saveServices(listServices().filter((u) => u !== url));
