/**
 * The shortcuts that fill the request form and send it for you: quick actions on a reply,
 * answering a CLARIFY, and the preset scenarios. Each changes the form one step per tick,
 * so the form's own rules (capability, target) settle between steps.
 */
import { type ComputedRef, computed, nextTick, type Ref } from 'vue';
import type { Exchange, RequestForm, ServiceKey, TargetVerb } from './model';
import { type Examples, type PresetKind, presetFor } from './presets';
import { proposedBy } from './seen';

interface ShortcutDeps {
  form: RequestForm;
  log: Ref<Exchange[]>;
  current: ComputedRef<Exchange | null>;
  examples: Examples;
  send: () => Promise<void>;
}

/** How a shortcut sends a COMMIT, UNDO or EXPAND of `target`. */
type Act = (
  verb: TargetVerb,
  target: string,
  service?: ServiceKey,
) => Promise<void>;

/**
 * Ask again after a decline: what the exchange on show could ask again from, and the asking.
 */
function askAgainFrom({ form, log, current, send }: ShortcutDeps, act: Act) {
  /** Where the exchange on show could ask again from: the INTENT behind its proposal. */
  const askable = computed(() =>
    current.value ? proposedBy(log.value, current.value) : null,
  );

  /**
   * Ask again after a decline: the INTENT behind the declined proposal, sent afresh, then a
   * COMMIT of the new proposal in its place, so a new one waits on the human. The declined
   * proposal itself is never committed.
   */
  async function askAgain(): Promise<void> {
    const service = current.value?.service;
    const req = askable.value?.intent.request;

    if (!service || req?.verb !== 'INTENT') {
      return;
    }

    const at = askable.value?.at ?? 0;

    form.service = service;
    await nextTick();
    form.verb = 'INTENT';
    form.capability = req.capability;
    form.params = JSON.stringify(req.params ?? {}, null, 2);
    Object.assign(form, { auto: req.auto ?? false, useBudget: false });
    await nextTick();
    await send();

    const r = current.value?.reply;
    const p =
      r?.kind === 'PROPOSALS'
        ? r.proposals.at(Math.min(at, r.proposals.length - 1))
        : undefined;

    if (p) {
      await act('COMMIT', p.id, service);
    }
  }

  return { askable, askAgain };
}

export function useShortcuts(deps: ShortcutDeps) {
  const { form, current, examples, send } = deps;

  /** Pick the service, then the verb, then the target, and send. */
  async function act(
    verb: TargetVerb,
    target: string,
    service = current.value?.service,
  ): Promise<void> {
    if (!service) {
      return;
    }

    form.service = service;
    await nextTick();
    form.verb = verb;
    await nextTick();
    form.target = target;
    await send();
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

  /** Run a preset scenario, one form step per tick; resolves once its last reply is in. */
  async function runPreset(kind: PresetKind): Promise<void> {
    const p = presetFor(kind, examples);

    form.service = p.service;
    await nextTick();
    form.verb = p.verb;
    form.capability = p.capability;
    form.params = JSON.stringify(p.params, null, 2);
    Object.assign(form, { auto: false, useBudget: false }, p.form);
    await nextTick();
    await send();

    if (p.commit) {
      await commitNext(p.commit, p.service);
    }
  }

  return { act, choose, runPreset, ...askAgainFrom(deps, act) };
}
