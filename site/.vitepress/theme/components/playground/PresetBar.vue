<script setup lang="ts">
/** The preset scenarios: one button each, which fills the form and sends for you. */
import { PRESET_BUTTONS, type PresetKind } from './presets';

const emit = defineEmits<{ preset: [kind: PresetKind] }>();
</script>

<template>
  <div class="presets" role="group" aria-label="Try a scenario">
    <button v-for="p in PRESET_BUTTONS" :key="p.kind" type="button" @click="emit('preset', p.kind)">{{ p.label }}</button>
  </div>
</template>

<style scoped src="./pill.css"></style>
<style scoped>
.presets { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; max-width: 560px; }

@media (max-width: 980px) {
  .presets { justify-content: flex-start; }
}
</style>
