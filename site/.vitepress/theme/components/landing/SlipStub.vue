<script setup lang="ts">
/**
 * The slip's tear-off stub: the consent the visitor signs (the proposal's hash and one
 * Approve button), then the receipt with Undo, then the undo; its words come from the chosen
 * example. Once the core is live, Start again is always there. When a button is replaced by
 * the next one, focus moves to it, and one live line says what happened.
 */
import { withBase } from 'vitepress';
import { computed, nextTick, useTemplateRef, watch } from 'vue';
import { SCENES } from './scenes';
import { keepDates } from './slip-view';
import type { SlipModel } from './use-slip';

const props = defineProps<{ s: SlipModel }>();
const stub = useTemplateRef<HTMLElement>('stub');
const scene = computed(() => SCENES[props.s.scene]);

/** Set when the visitor presses a button, until its step ends and the next button has focus. */
let acted = false;

function press(what: 'approve' | 'undo' | 'again') {
  acted = true;
  void props.s[what]();
}

/** The line under the Approve button, before anything is approved. */
const fine = computed(() => {
  switch (props.s.phase) {
    case 'loading':
      return 'Starting the protocol core in your browser…';
    case 'asking':
    case 'proposed':
    case 'checking':
      return 'Nothing to sign unless your policy says it needs you.';
    default:
      return `Signs a one-time grant for this hash at ${props.s.slip.service}, and nothing else.`;
  }
});

/** The phases while a run leads up to its outcome. */
const LEADING = ['asking', 'proposed', 'checking'];
const BUSY = ['loading', ...LEADING, 'approving', 'undoing'];

/**
 * A held Enter repeats. After Start again, focus lands on Approve once the new proposal
 * waits; a repeat from the key still held down must not approve it. Only a fresh press does.
 */
function noRepeat(e: KeyboardEvent) {
  if (e.repeat) {
    e.preventDefault();
  }
}

/** When a step ends, its button has been replaced: focus the next one, if focus was here. */
watch(
  () => props.s.phase,
  async (now) => {
    const active = document.activeElement;
    const here =
      !active || active === document.body || stub.value?.contains(active);

    if (!acted || BUSY.includes(now)) {
      return;
    }

    acted = false;

    if (here) {
      await nextTick();
      stub.value
        ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        ?.focus();
    }
  },
);
</script>

<template>
  <div ref="stub" class="stub">
    <template v-if="s.phase === 'committed' || s.phase === 'undoing'">
      <p class="line">
        {{ scene.done }}
        <template v-if="s.receipt?.undoUntil">You can undo it until <template v-for="(part, i) in keepDates(s.receipt.undoUntil)" :key="i"><span v-if="part.date" class="nowrap">{{ part.text }}</span><template v-else>{{ part.text }}</template></template>.</template>
        <template v-else>It can't be undone.</template>
      </p>
      <p class="receipt">Receipt <span class="mono">{{ s.receipt?.id }}</span></p>
      <pre class="result">{{ s.receipt?.result.join('\n') }}</pre>
      <div class="row">
        <button class="btn" type="button" :disabled="s.phase === 'undoing'" @click="press('undo')">{{ s.phase === 'undoing' ? 'Undoing…' : 'Undo' }}</button>
        <button class="btn quiet" type="button" :disabled="s.phase === 'undoing'" @click="press('again')">Start again</button>
      </div>
      <p class="fine">Undo asks {{ s.slip.service }} to reverse it; it issues a new receipt.</p>
    </template>

    <template v-else-if="s.phase === 'undone'">
      <p class="line">{{ scene.undone }}</p>
      <p class="receipt">Receipt <span class="mono">{{ s.undone?.id }}</span> reverses <span class="mono">{{ s.undone?.undoes }}</span>.</p>
      <div class="row">
        <button class="btn" type="button" @click="press('again')">Start again</button>
        <a :href="withBase('/guide/mcp-typescript')">Put this in front of your own tools</a>
      </div>
    </template>

    <template v-else-if="s.phase === 'expired' || s.phase === 'error'">
      <p :class="['line', { err: s.phase === 'error' }]">{{ s.error }}</p>
      <div class="row">
        <button class="btn" type="button" @click="press('again')">Start again</button>
      </div>
    </template>

    <template v-else>
      <p class="line">{{ LEADING.includes(s.phase) ? 'If your policy needs you, you approve this hash' : 'You approve this hash' }}</p>
      <p class="hash">{{ s.slip.hash }}</p>
      <div class="row">
        <button :class="['btn', 'consent', { off: s.phase === 'unavailable' }]" type="button" :disabled="s.phase !== 'waiting'" @keydown.enter="noRepeat" @click="press('approve')">{{ s.phase === 'approving' ? 'Approving…' : 'Approve' }}</button>
        <button v-if="s.live && s.phase === 'waiting'" class="btn quiet" type="button" @click="press('again')">Start again</button>
      </div>
      <p v-if="s.phase === 'unavailable'" class="fine err">✗ The protocol core couldn't start in this browser ({{ s.error }}), so this is the recorded exchange.</p>
      <p v-else class="fine">{{ fine }}</p>
    </template>

    <p class="visually-hidden" role="status">{{ s.status }}</p>
  </div>
</template>

<style scoped>
/* The perforation: a dashed rule with a notch cut into each edge of the slip. The notch is
   painted in the colour behind the slip (--l-notch, set by the hero band), and follows it. */
.stub { position: relative; display: grid; gap: 12px; margin: 4px calc(-1 * clamp(20px, 3vw, 28px)) 0; padding: 20px clamp(20px, 3vw, 28px) 0; border-top: 1px dashed var(--edge); }
.stub::before, .stub::after { content: ""; position: absolute; top: -10px; width: 18px; height: 18px; border-radius: 50%; background: var(--l-notch, var(--vp-c-bg)); border: 1px solid var(--edge); transition: background-color 900ms var(--l-ease-out); }
.stub::before { left: -10px; clip-path: inset(0 0 0 50%); }
.stub::after { right: -10px; clip-path: inset(0 50% 0 0); }

.line { font-weight: 650; }
/* The outcome leads; the receipt id follows as the reference. */
.receipt { font-size: 0.875rem; color: var(--vp-c-text-2); margin-top: -6px; }
.nowrap { white-space: nowrap; }
.mono, .hash, .result { font-family: var(--l-mono); }
.mono { font-size: 0.92em; font-weight: 500; }
.hash { font-size: 0.875rem; color: var(--vp-c-text-1); overflow-wrap: anywhere; line-height: 1.5; }
.result { margin: 0; font-size: 0.8125rem; line-height: 1.7; color: var(--state-green); white-space: pre-wrap; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
/* Two lines kept for the note, so it doesn't move the page when the core starts. */
.fine { font-size: 0.875rem; color: var(--vp-c-text-2); min-height: calc(2 * 1.65em); }
.err { color: var(--state-red); }
/* Every Approve that signs a proposal is amber, the consent colour, like the playground's. */
.btn.consent { min-width: 9.5rem; background: var(--consent-bg); color: var(--consent-text); border-color: var(--consent-bg); }
.btn.consent:hover:not(:disabled) { background: var(--consent-hover-bg); border-color: var(--consent-hover-bg); }
.btn.quiet { border-color: transparent; text-decoration: underline; text-underline-offset: 0.2em; }
.btn.off:disabled { cursor: not-allowed; }
</style>
