<script setup lang="ts">
/** The last word: try it in the browser, read the spec, or find the code. */
import { withBase } from 'vitepress';

const REPO = 'https://github.com/yea-protocol/yea';
</script>

<template>
  <section class="band end" aria-labelledby="end-title">
    <h2 id="end-title">Try it without installing anything</h2>
    <p class="prose">
      Play the agent against a calendar, a shop and a billing system, set the human's policy, and watch what the model would
      read.
    </p>
    <div class="actions">
      <a class="btn primary" :href="withBase('/playground')">Open the playground</a>
      <a class="btn" :href="withBase('/reference/spec')">Read the spec</a>
      <a :href="REPO">Star on GitHub</a>
    </div>
  </section>
</template>

<style scoped>
.end { display: grid; gap: 20px; padding-bottom: clamp(80px, 10vw, 128px); }
.actions { margin-top: 8px; }
</style>
