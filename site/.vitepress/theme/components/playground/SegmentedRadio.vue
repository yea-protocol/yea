<script setup lang="ts" generic="T extends string">
/**
 * A segmented control that is a radiogroup (WAI-ARIA radio group pattern): one tab stop,
 * the arrow keys (and Home, End) move the choice, and a click picks one.
 */
import { focusSibling, moveIndex } from './roving';

const props = defineProps<{
  label: string;
  options: readonly { value: T; text: string }[];
  mono?: boolean;
}>();

const model = defineModel<T>({ required: true });

function onKey(e: KeyboardEvent, i: number) {
  const next = moveIndex(e.key, i, props.options.length);

  if (next === null) {
    return;
  }

  e.preventDefault();
  model.value = props.options[next].value;
  focusSibling(e, next);
}
</script>

<template>
  <div :class="['seg', { mono }]" role="radiogroup" :aria-label="label">
    <button
      v-for="(o, i) in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="model === o.value"
      :tabindex="model === o.value ? 0 : -1"
      @click="model = o.value"
      @keydown="onKey($event, i)"
    >{{ o.text }}</button>
  </div>
</template>

<style scoped src="./segmented.css"></style>
