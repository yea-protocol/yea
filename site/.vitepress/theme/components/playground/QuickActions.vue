<script setup lang="ts">
/** One-click next steps on a reply: commit a proposal, answer a CLARIFY, undo a receipt, expand a handle. */
import { computed } from 'vue';
import type { Exchange, TargetVerb } from './model';
import { moreOf } from './seen';

const props = defineProps<{ exchange: Exchange }>();
const emit = defineEmits<{
  act: [verb: TargetVerb, target: string];
  choose: [option: { label: string; params: Record<string, unknown> }];
}>();

const reply = computed(() => props.exchange.reply);
const proposals = computed(() =>
  reply.value.kind === 'PROPOSALS' ? reply.value.proposals : [],
);
const options = computed(() =>
  reply.value.kind === 'CLARIFY' ? reply.value.options : [],
);
/** The receipt to offer an Undo for: one that isn't an undo itself and still has a window. */
const undoable = computed(() => {
  const r = reply.value;

  return r.kind === 'RECEIPT' && !r.receipt.undoes && r.receipt.undo
    ? r.receipt.id
    : null;
});
const more = computed(() => moreOf(reply.value));
</script>

<template>
  <div class="quick">
    <template v-if="reply.kind === 'PROPOSALS'">
      <button v-for="p in proposals" :key="p.id" type="button" class="pill" @click="emit('act', 'COMMIT', p.id)">Commit {{ p.id }}</button>
    </template>
    <template v-if="reply.kind === 'CLARIFY'">
      <button v-for="o in options" :key="o.label" type="button" class="pill" @click="emit('choose', o)">{{ o.label }}</button>
    </template>
    <button v-if="undoable" type="button" class="pill" @click="emit('act', 'UNDO', undoable)">Undo {{ undoable }}</button>
    <button v-for="m in more" :key="m.handle" type="button" class="pill" @click="emit('act', 'EXPAND', m.handle)">Expand {{ m.path }}</button>
  </div>
</template>

<style scoped src="./pill.css"></style>
<style scoped>
.quick { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 18px 18px; }
</style>
