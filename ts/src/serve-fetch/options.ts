/** The fetch handler `serveFetch` serves, its gate and options, and the settings each request is served with. */

/** A fetch-API handler: Workers, Bun, Deno, and Node through `serveFetch`. */
export type FetchApp = (req: Request) => Response | Promise<Response>;

/** A check before the body is read: a Response refuses the request, undefined lets it through. */
export type FetchGate = (
  req: Request,
) => Response | undefined | Promise<Response | undefined>;

export interface ServeFetchOptions {
  /** Default 8080. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /**
   * The most bytes a request body may have (default 1 MiB). A bigger one is answered 413 as soon
   * as it's declared or has arrived, and the app never sees it.
   */
  maxBody?: number;
  /**
   * Pass the request's headers to the app (default false: the app sees the method, the URL and
   * the body only). MCP's Streamable HTTP needs them: Authorization, Accept, Content-Type,
   * Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID and more. They arrive as sent, including
   * any X-Forwarded-* a client sets.
   */
  headers?: boolean;
  /**
   * Runs before the body is read, on a bodiless Request with the method, the URL and the
   * headers. A Response it returns is sent instead of running the app (an authentication
   * check, so a caller without credentials can't make the server read a body).
   */
  gate?: FetchGate;
  /** Milliseconds a client has to send the whole request, headers and body (default 30 000). */
  requestTimeout?: number;
  /** At most this many connections at once (default: no limit). */
  maxConnections?: number;
}

export interface Settings {
  max: number;
  tooLarge: string;
  headers: boolean;
  gate?: FetchGate;
  /** The client sent `Expect: 100-continue` and waits for our go-ahead before its body. */
  expectsContinue?: boolean;
}
