/**
 * The test drive's throwaway world: the example calendar and shop in-process, a fresh principal
 * and agent, and a temp home for the agent's consents. The principal is held in memory only; it
 * is never written to the home, nor to anywhere `YEA_HOME` or `YEA_PRINCIPAL_HOME` points.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Client,
  type ConsentStore,
  issueGrant,
  type KeyPair,
  keyPair,
  local,
  unixNow,
} from '@yea-protocol/sdk';
import { calendar, shop } from '@yea-protocol/sdk/examples';
import { homeConsents } from '@yea-protocol/sdk/node';

/** The policy the throwaway principal signs, as the person and the model are told it. */
export const POLICY_TEXT =
  'low-risk actions only, up to 40.00 USD per action and 100.00 USD total';

export interface Throwaway {
  /** The agent's home: the bridge reads `policy.json` and keeps consents here. */
  home: string;
  /** The home's consent store, shared by the bridge and the person's approvals. */
  consents: ConsentStore;
  /** The person's key. In memory only, and used only by the person's loop. */
  principal: KeyPair;
  /** The agent's public key, which consents are issued to. */
  agent: string;
  /** The agent's clients to the example services, with the principal's grant. */
  clients: Client[];
  /** Close the clients and delete the home. */
  close(): void;
}

/** A fresh world for one test drive; nothing in it touches `~/.yea`. */
export async function throwaway(): Promise<Throwaway> {
  const home = mkdtempSync(join(tmpdir(), 'yea-test-drive-'));
  const principal = await keyPair();
  const agent = await keyPair();
  const grant = await issueGrant({
    principal,
    to: agent.public,
    caveats: [
      { risk: 'low' },
      { each: { of: 'spend', max: 4000, scale: 2, unit: 'USD' } },
      { total: { of: 'spend', max: 10000, scale: 2, unit: 'USD' } },
      { exp: unixNow() + 3600 },
    ],
  });
  const trust = [principal.public];
  const clients = [calendar({ trust }), shop({ trust })].map(
    (s) => new Client(local(s), { key: agent.seed, grants: [grant] }),
  );

  return {
    home,
    consents: homeConsents(home),
    principal,
    agent: agent.public,
    clients,
    close() {
      for (const c of clients) {
        c.close();
      }

      rmSync(home, { recursive: true, force: true });
    },
  };
}
