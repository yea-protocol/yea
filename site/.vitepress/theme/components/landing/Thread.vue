<script setup lang="ts">
/**
 * The exchange beside the slip, as a thread: the person's request, the agent's intent, the
 * service's proposals and the policy's answer arrive one at a time and stay, then the
 * visitor's own approval, receipt and undo. The wire line leads; a sentence under it says what
 * it means. Whoever speaks next has a pulsing dot. Every message keeps its final size from the
 * start, so nothing moves as they arrive. Each dot (data-junction) starts a background path.
 * Skip and Replay ignore a held Enter's repeats, like Approve.
 */

import { noRepeat } from './keys';
import type { Message } from './thread';

defineProps<{
  messages: Message[];
  /** While playing, how many messages have arrived. */
  reveal: number;
  playing: boolean;
  /** The page runs, so Replay and Skip can work. */
  ready: boolean;
}>();

const emit = defineEmits<{ replay: []; skip: [] }>();
</script>

<template>
  <div class="thread">
    <ol class="messages" aria-label="The exchange">
      <li
        v-for="(m, i) in messages"
        :key="i"
        :class="['msg', m.tone, { shown: !playing || i < reveal, next: playing && i === reveal, reply: m.reply && !playing }]"
        data-message
      >
        <p class="from"><span class="dot" data-junction aria-hidden="true" />{{ m.from }}</p>
        <div class="body">
          <p v-if="m.wire" class="wire">{{ m.wire }}</p>
          <p class="text">{{ m.text }}</p>
        </div>
      </li>
    </ol>
    <!-- Its row is kept before the page starts (and without JavaScript), so nothing moves. -->
    <button type="button" :class="['control', { idle: !ready }]" :tabindex="ready ? undefined : -1" :aria-hidden="ready ? undefined : 'true'" data-playback @keydown.enter="noRepeat" @click="playing ? emit('skip') : emit('replay')">
      {{ playing ? 'Skip to the end' : 'Replay the exchange' }} <span aria-hidden="true">{{ playing ? '→' : '↺' }}</span>
    </button>
  </div>
</template>

<style scoped>
.thread { display: grid; gap: 12px; }
.messages { list-style: none; margin: 0; padding: 0; display: grid; gap: 20px; }

/* Every message holds its place and size before it arrives, so nothing below it moves. */
.msg { display: grid; gap: 6px; opacity: 0; transition: opacity 420ms var(--l-ease-out); }
.msg.shown, .msg.next { opacity: 1; }
.msg.next .body { visibility: hidden; }
.from { display: flex; align-items: center; gap: 10px; font-size: 0.8125rem; font-weight: 600; color: var(--vp-c-text-2); }
.dot { flex: none; width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--vp-c-text-3); background: var(--vp-c-bg); }
.shown .dot { background: var(--vp-c-text-2); border-color: var(--vp-c-text-2); }
.shown.amber .dot { background: var(--amber); border-color: var(--state-amber); }
.shown.green .dot { background: var(--green); border-color: var(--state-green); }
/* Who speaks next. */
.next .dot { animation: next 1100ms ease-in-out infinite; }
@keyframes next { 50% { background: var(--vp-c-text-2); border-color: var(--vp-c-text-2); } }

.body { display: grid; gap: 4px; padding-left: 19px; }
/* The real message leads, whole: it wraps with a hanging indent instead of being cut off. */
.wire { font-family: var(--l-mono); font-size: 0.8125rem; line-height: 1.55; color: var(--vp-c-text-1); white-space: pre-wrap; overflow-wrap: anywhere; padding-left: 2ch; text-indent: -2ch; }
.amber .wire { color: var(--state-amber); }
.green .wire { color: var(--state-green); }
.text { font-size: 0.9375rem; line-height: 1.5; color: var(--vp-c-text-2); max-width: 48ch; }
/* The person's own words are the message itself. */
.msg:first-child .text { font-size: 1rem; font-weight: 600; color: var(--vp-c-text-1); }

/* Skip while playing, Replay after: one button with a link's look, a 44px target. */
.control { justify-self: start; min-height: 44px; padding: 0; border: 0; background: none; font: inherit; font-size: 0.9375rem; font-weight: 650; color: var(--vp-c-text-1); text-decoration: underline; text-decoration-color: var(--vp-c-text-3); text-underline-offset: 0.2em; cursor: pointer; }
.control:hover { text-decoration-color: currentColor; }
.control.idle { visibility: hidden; }
/* Without motion there is nothing to replay. */
@media (prefers-reduced-motion: reduce) {
  .control { display: none; }
}

/* The visitor's own messages (approve, receipt, undo) arrive in turn as they happen. */
@starting-style {
  .msg.shown { opacity: 0; }
}
.msg.reply { transition-delay: 600ms; }
</style>
