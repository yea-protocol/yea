<script setup lang="ts">
/**
 * What shows while the SDK and services load: the two panes' outlines, so the page doesn't
 * jump when they arrive, and a status line for screen readers and anyone waiting.
 */
</script>

<template>
  <div class="panes">
    <p class="loading" role="status">Starting the services…</p>
    <div class="pane ghost" aria-hidden="true">
      <span class="bar seg-bar" />
      <span class="bar seg-bar" />
      <span class="bar label" />
      <span class="bar field" />
      <span class="bar label" />
      <span class="bar box" />
      <span class="bar send" />
    </div>
    <div class="pane ghost" aria-hidden="true">
      <span class="bar label" />
      <span class="bar line" />
      <span class="bar line short" />
      <span class="bar line" />
      <span class="bar line short" />
    </div>
  </div>
</template>

<style scoped src="./panes.css"></style>
<style scoped>
.loading { grid-column: 1 / -1; margin: 0; color: var(--vp-c-text-2); }
.ghost { display: flex; flex-direction: column; gap: 12px; padding: 18px; }
.bar { display: block; border-radius: 8px; background: var(--vp-c-bg-soft); animation: pulse 1.6s ease-in-out infinite; }
.seg-bar { height: 40px; border-radius: 8px; }
.label { height: 12px; width: 30%; }
.field { height: 38px; }
.box { height: 150px; }
.send { height: 44px; border-radius: 8px; }
.line { height: 14px; }
.short { width: 60%; }

@keyframes pulse {
  50% { opacity: 0.5; }
}
@media (prefers-reduced-motion: reduce) {
  .bar { animation: none; }
}
</style>
