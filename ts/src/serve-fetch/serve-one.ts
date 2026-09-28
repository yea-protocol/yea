/** Serving one request: gate, capped body, app. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { declaredOver, readCapped } from './body.js';
import { fail, headOf, relay, toRequest } from './messages.js';
import type { FetchApp, FetchGate, Settings } from './options.js';
import { refuse, textResponse } from './refuse.js';

/** The gate's answer; a gate that throws refuses with 500. */
async function gateOf(gate: FetchGate | undefined, head: Request) {
  try {
    return gate ? await gate(head) : undefined;
  } catch {
    return textResponse(500, 'internal error');
  }
}

/** Run the app on the request and relay its answer; an app that throws gets 500. */
async function runApp(app: FetchApp, request: Request, res: ServerResponse) {
  try {
    await relay(await app(request), res);
  } catch {
    fail(res, 500);
  }
}

/**
 * For `Expect: 100-continue`, once the gate has passed: 413 a declared body over the cap, else
 * send 100 Continue. True when the body may be read.
 */
async function goAhead(req: IncomingMessage, res: ServerResponse, o: Settings) {
  if (!o.expectsContinue) {
    return true;
  }

  if (declaredOver(req, o.max)) {
    await refuse(req, res, textResponse(413, o.tooLarge), false);

    return false;
  }

  res.writeContinue();

  return true;
}

/**
 * One request: the gate (before any body is read, and before any 100 Continue), the body
 * (capped), then the app. A request that can't be parsed is answered 400.
 */
export async function serveOne(
  app: FetchApp,
  req: IncomingMessage,
  res: ServerResponse,
  o: Settings,
) {
  let head: Request;

  try {
    head = headOf(req);
  } catch {
    await refuse(
      req,
      res,
      textResponse(400, 'bad request'),
      !o.expectsContinue,
    );

    return;
  }

  const stop = await gateOf(o.gate, head);

  if (stop) {
    await refuse(req, res, stop, !o.expectsContinue);

    return;
  }

  if (!(await goAhead(req, res, o))) {
    return;
  }

  let body: Buffer<ArrayBuffer> | null;

  try {
    body = await readCapped(req, o.max);
  } catch {
    fail(res, 400);

    return;
  }

  if (!body) {
    await refuse(req, res, textResponse(413, o.tooLarge));

    return;
  }

  await runApp(app, toRequest(head, res, { body, headers: o.headers }), res);
}
