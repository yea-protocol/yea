/** Register an operation on the service: a GET as an ASK, any other method as an irreversible INTENT. */
import type { Plan } from '../plan.js';
import type { Service } from '../service.js';
import type { Effect } from '../types.js';
import type { Op } from './operations.js';
import type { OpenApiOptions } from './options.js';
import { projectFields } from './project.js';
import { buildRequest, callUpstream, type Upstream } from './upstream.js';

const WRITE: Record<string, Effect['op']> = {
  post: 'create',
  put: 'update',
  patch: 'update',
  delete: 'delete',
};

const shape = (o: OpenApiOptions, op: Op, data: unknown) =>
  op.id && o.project?.[op.id] ? projectFields(data, o.project[op.id]) : data;

export function addAsk(svc: Service, op: Op, up: Upstream) {
  svc.ask(op.name, {
    summary: op.summary,
    params: Object.keys(op.params).length ? op.params : undefined,
    run: async ({ params: p }) => {
      const { url } = buildRequest(up.baseUrl, op, p);

      return shape(
        up.o,
        op,
        await callUpstream(up, { method: 'get', url, body: undefined }),
      );
    },
  });
}

export function addIntent(svc: Service, op: Op, up: Upstream) {
  const risk =
    up.o.risk?.(op.method, op.path, op.raw) ??
    (op.method === 'delete' ? 'medium' : 'low');

  svc.intent(op.name, {
    summary: op.summary,
    params: Object.keys(op.params).length ? op.params : undefined,
    risk,
    plan: ({ params: p }): Plan => {
      const { url, body } = buildRequest(up.baseUrl, op, p);
      const verb = op.method.toUpperCase();

      return {
        summary: `${verb} ${url.pathname + url.search}`,
        effects: [
          {
            op: WRITE[op.method] ?? 'other',
            target: `${url.host}${url.pathname}`,
            detail:
              body !== undefined
                ? `body ${JSON.stringify(body).slice(0, 160)}`
                : `${verb} request`,
          },
        ],
        risk,
        apply: async () =>
          shape(
            up.o,
            op,
            await callUpstream(up, { method: op.method, url, body }),
          ),
      };
    },
  });
}
