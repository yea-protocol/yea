<script setup lang="ts">
/**
 * The slip's tear-off stub: the consent the visitor signs (the proposal's hash and one
 * Approve button), then the receipt with Undo, then the undo. Once the core is live, Start
 * again is always there. When a button is replaced by the next one, focus moves to it, and
 * one live line says what happened.
 */
import { withBase } from 'vitepress';
import { nextTick, useTemplateRef, watch } from 'vue';
import {
  keepDates,
  type ReceiptView,
  type SlipView,
  type UndoneView,
} from './slip-view';
import type { Phase } from './use-slip';

const props = defineProps<{
  phase: Phase;
  live: boolean;
  slip: SlipView;
  receipt: ReceiptView | null;
  undone: UndoneView | null;
  status: string;
  error: string;
}>();
const emit = defineEmits<{ approve: []; undo: []; again: [] }>();
const stub = useTemplateRef<HTMLElement>('stub');

/** Set when the visitor presses a button, until its step ends and the next button has focus. */
let acted = false;

function press(what: 'approve' | 'undo' | 'again') {
  acted = true;

  if (what === 'approve') {
    emit('approve');
  } else if (what === 'undo') {
    emit('undo');
  } else {
    emit('again');
  }
}

/** When a step ends, its button has been replaced: focus the next one, if focus was here. */
watch(
  () => props.phase,
  async (now) => {
    const busy = now === 'loading' || now === 'approving' || now === 'undoing';
    const active = document.activeElement;
    const here =
      !active || active === document.body || stub.value?.contains(active);

    if (!acted || busy) {
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
    <template v-if="phase === 'committed' || phase === 'undoing'">
      <p class="line">
        Order placed.
        <template v-if="receipt?.undoUntil">You can undo it until <template v-for="(part, i) in keepDates(receipt.undoUntil)" :key="i"><span v-if="part.date" class="nowrap">{{ part.text }}</span><template v-else>{{ part.text }}</template></template>.</template>
        <template v-else>It can't be undone.</template>
      </p>
      <p class="receipt">Receipt <span class="mono">{{ receipt?.id }}</span></p>
      <pre class="result">{{ receipt?.result.join('\n') }}</pre>
      <div class="row">
        <button class="btn" type="button" :disabled="phase === 'undoing'" @click="press('undo')">{{ phase === 'undoing' ? 'Undoing…' : 'Undo' }}</button>
        <button class="btn quiet" type="button" :disabled="phase === 'undoing'" @click="press('again')">Start again</button>
      </div>
      <p class="fine">Undo asks the shop to reverse the order; it issues a new receipt.</p>
    </template>

    <template v-else-if="phase === 'undone'">
      <p class="line">Order cancelled.</p>
      <p class="receipt">Receipt <span class="mono">{{ undone?.id }}</span> reverses <span class="mono">{{ undone?.undoes }}</span>.</p>
      <div class="row">
        <button class="btn" type="button" @click="press('again')">Start again</button>
        <a :href="withBase('/guide/mcp-typescript')">Put this in front of your own tools</a>
      </div>
    </template>

    <template v-else-if="phase === 'expired' || phase === 'error'">
      <p :class="['line', { err: phase === 'error' }]">{{ error }}</p>
      <div class="row">
        <button class="btn" type="button" @click="press('again')">Start again</button>
      </div>
    </template>

    <template v-else>
      <p class="line">You approve this hash</p>
      <p class="hash">{{ slip.hash }}</p>
      <div class="row">
        <button :class="['btn', 'consent', { off: phase === 'unavailable' }]" type="button" :disabled="phase !== 'waiting'" @click="press('approve')">{{ phase === 'approving' ? 'Approving…' : 'Approve' }}</button>
        <button v-if="live && phase === 'waiting'" class="btn quiet" type="button" @click="press('again')">Start again</button>
      </div>
      <p v-if="phase === 'unavailable'" class="fine err">✗ The protocol core couldn't start in this browser ({{ error }}), so this is the recorded exchange.</p>
      <p v-else-if="!live" class="fine">Starting the protocol core in your browser…</p>
      <p v-else class="fine">Signs a one-time grant for this hash at {{ slip.service }}, and nothing else.</p>
    </template>

    <p class="visually-hidden" role="status">{{ status }}</p>
  </div>
</template>

<style scoped>
/* The perforation: a dashed rule with a notch cut into each edge of the slip. */
.stub { position: relative; display: grid; gap: 12px; margin: 4px calc(-1 * clamp(20px, 3vw, 28px)) 0; padding: 20px clamp(20px, 3vw, 28px) 0; border-top: 1px dashed var(--edge); }
.stub::before, .stub::after { content: ""; position: absolute; top: -10px; width: 18px; height: 18px; border-radius: 50%; background: var(--vp-c-bg); border: 1px solid var(--edge); }
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
