/**
 * The shortcuts that fill the request form and send it for you: quick actions on a reply,
 * answering a CLARIFY, and the preset scenarios. Each changes the form one step per tick,
 * so the form's own rules (capability, target) settle between steps.
 */
import { type ComputedRef, nextTick } from 'vue';
import type { Exchange, RequestForm, ServiceKey, TargetVerb } from './model';
import { type Examples, type PresetKind, presetFor } from './presets';

interface ShortcutDeps {
  form: RequestForm;
  current: ComputedRef<Exchange | null>;
  examples: Examples;
  send: (extraGrants?: string[]) => Promise<void>;
}

export function useShortcuts({ form, current, examples, send }: ShortcutDeps) {
  /** Pick the service, then the verb, then the target, and send. */
  async function act(
    verb: TargetVerb,
    target: string,
    service = current.value?.service,
    extraGrants?: string[],
  ): Promise<void> {
    if (!service) {
      return;
    }

    form.service = service;
    await nextTick();
    form.verb = verb;
    await nextTick();
    form.target = target;
    await send(extraGrants);
  }

  /** Answer a CLARIFY: the same INTENT again, with the option's params merged in. */
  async function choose(option: { params: object }): Promise<void> {
    const x = current.value;

    if (!x || (x.request.verb !== 'INTENT' && x.request.verb !== 'ASK')) {
      return;
    }

    const req = x.request;

    form.service = x.service;
    await nextTick();
    form.verb = 'INTENT';
    form.capability = req.capability;
    form.params = JSON.stringify(
      { ...(req.params ?? {}), ...option.params },
      null,
      2,
    );
    await send();
  }

  /** A preset's second step: commit the first or last proposal it got back. */
  async function commitNext(which: 'first' | 'last', service: ServiceKey) {
    const r = current.value?.reply;

    if (r?.kind === 'PROPOSALS') {
      const p =
        which === 'first'
          ? r.proposals[0]
          : r.proposals[r.proposals.length - 1];

      if (p) {
        await act('COMMIT', p.id, service);
      }
    }
  }

  function runPreset(kind: PresetKind): void {
    const p = presetFor(kind, examples);

    form.service = p.service;
    void nextTick(() => {
      form.verb = p.verb;
      form.capability = p.capability;
      form.params = JSON.stringify(p.params, null, 2);
      Object.assign(form, { auto: false, useBudget: false }, p.form);
      void nextTick(async () => {
        await send();

        if (p.commit) {
          await commitNext(p.commit, p.service);
        }
      });
    });
  }

  return { act, choose, runPreset };
}
