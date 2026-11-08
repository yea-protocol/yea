/**
 * The options `yea()` takes (SPEC-mcp-ts `yea(options)`): their type, and the rules that close
 * them (SPEC-mcp-ts, "Closed options").
 */
import type {
  RequestStateCodec,
  ServerContext,
} from '@modelcontextprotocol/server';
import type { ApprovalStore, Risk } from '@yea-protocol/sdk';
import {
  aBoolean,
  aFunction,
  aRisk,
  aString,
  nested,
  oneOf,
  type Rule,
  required,
  strings,
  withMethods,
} from './options.js';

export interface YeaOptions {
  /** The server's name, `[a-z0-9._-]{1,64}`: names its key file and appears in consent codes. */
  name: string;
  transport: 'stdio' | 'http';
  /**
   * The home directory: `policy.json`, the default store and the default server key live in it.
   * Default `YEA_HOME`, else `~/.yea`, resolved once. The principal key is never read from it.
   */
  home?: string;
  /** Default: a FileStore (`YEA_STORE`, else `<home>/store`) for stdio, a MemoryStore for HTTP. */
  store?: ApprovalStore;
  /** HTTP only: a promise that one process serves every request. HTTP on a MemoryStore must set it. */
  singleProcess?: boolean;
  /** Path to the server's Ed25519 seed. Default `<home>/server/<name>.key`, created on first run. */
  serverKey?: string;
  /** The pinned principal public key. Default: the file `YEA_PRINCIPAL_PUB` names, checked. */
  principal?: string;
  /** The signed policy grant: a `pg1.` token, or a path to one. Default `YEA_POLICY`. */
  policy?: string;
  /** Unsigned tightening, merged with `<home>/policy.json`: `{ deny?, outOfBand? }`. */
  tighten?: { deny?: string[]; outOfBand?: Risk };
  /** An existing `createRequestStateCodec` result; our state lives under its payload's `yea` key. */
  codec?: RequestStateCodec<unknown>;
  /** The ≥ 32-byte codec key. Only with a store every process shares. Default: random. */
  stateKey?: Uint8Array | string;
  /** Who is calling. stdio: `() => ''`. HTTP: required, from the transport's authentication. */
  sub?: (ctx: ServerContext) => string;
  /**
   * Mark job tools, guarded tools and `undo` with `_meta['anthropic/requiresUserInteraction']`:
   * Claude Code then prompts for every call, even in `auto` or `bypassPermissions`, and denies
   * them in `claude -p`. For people who auto-approve tools. Default false.
   */
  requireInteraction?: boolean;
}

/** Every `ApprovalStore` method, as a record so the compiler keeps the list whole. */
const STORE_METHODS: Record<keyof ApprovalStore, true> = {
  consumeOnce: true,
  putReceipt: true,
  getReceipt: true,
  claimUndo: true,
  releaseUndo: true,
  markUndone: true,
  reserve: true,
  settle: true,
  release: true,
  used: true,
  putConsent: true,
  getConsent: true,
};

/** One rule per key of `YeaOptions`, and no other. */
export const YEA_OPTIONS = {
  name: required(aString),
  transport: required(oneOf('stdio', 'http')),
  home: aString,
  store: withMethods('an ApprovalStore', Object.keys(STORE_METHODS)),
  singleProcess: aBoolean,
  serverKey: aString,
  principal: aString,
  policy: aString,
  tighten: nested({ deny: strings, outOfBand: aRisk }),
  codec: withMethods('a createRequestStateCodec result', ['mint', 'verify']),
  stateKey: {
    is: 'a string or a Uint8Array',
    ok: (v) => typeof v === 'string' || v instanceof Uint8Array,
  },
  sub: aFunction,
  requireInteraction: aBoolean,
} satisfies Record<keyof YeaOptions, Rule>;
