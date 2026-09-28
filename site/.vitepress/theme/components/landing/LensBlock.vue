<script setup lang="ts">
/** Real protocol output as a model reads it, one line per row, coloured by protocol state. */
import { computed } from 'vue';
import { lineClass } from '../lens-lines';

const props = defineProps<{
  /** Lens text; lines starting with → are what the agent sent. */
  text: string;
  label: string;
  /** Whether a ✗ line is a consent request (amber), not a refusal (red). */
  consent?: boolean;
}>();

const lines = computed(() =>
  props.text.split('\n').map((t) => ({
    t,
    cls: t.startsWith('→') ? 'wire' : lineClass(t, props.consent ?? false),
  })),
);
</script>

<template>
  <figure class="lens-fig">
    <figcaption class="visually-hidden">{{ label }}</figcaption>
    <pre class="lens"><span v-for="(l, i) in lines" :key="i" :class="['ln', l.cls]">{{ l.t }}</span></pre>
  </figure>
</template>

<style scoped>
.lens-fig { margin: 0; min-width: 0; }
</style>
