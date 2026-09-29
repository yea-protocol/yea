<script setup lang="ts">
/**
 * The last word: try it in the browser, read the spec, or find the code. The band is the
 * theme inverted, edge to edge, so the page ends strongly without a colour of its own.
 */
import { withBase } from 'vitepress';

const REPO = 'https://github.com/yea-protocol/yea';
</script>

<template>
  <section class="end l-bleed" aria-labelledby="end-title">
    <div class="inner">
      <h2 id="end-title">Try it without installing anything</h2>
      <p class="prose">
        Play the agent against a calendar, a shop and a billing system, set the human's policy, and watch what the model would
        read.
      </p>
      <div class="actions">
        <a class="btn primary" :href="withBase('/playground')">Open the playground</a>
        <a class="btn" :href="withBase('/reference/spec')">Read the spec</a>
        <a class="btn ghost" :href="REPO">Star on GitHub</a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.end { --vp-c-bg: var(--ink); --vp-c-text-1: var(--bone); --vp-c-text-2: #B4B8BF; --vp-c-text-3: var(--muted); --vp-c-border: #2C3240; --vp-c-brand-1: #A3B8DF; padding-block: clamp(80px, 10vw, 128px); background: var(--vp-c-bg); color: var(--vp-c-text-1); }
.dark .end { --vp-c-bg: var(--paper); --vp-c-text-1: var(--ink); --vp-c-text-2: #3C414B; --vp-c-text-3: #5C616A; --vp-c-border: #CFC9BB; --vp-c-brand-1: #385281; }
.inner { max-width: var(--l-wide); margin: 0 auto; display: grid; gap: 20px; }
.actions { margin-top: 8px; }
</style>
