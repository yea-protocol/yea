<script setup lang="ts">
/** What a real model said when its order hit the limit, with a link to the unedited session. */
import { withBase } from 'vitepress';
</script>

<template>
  <section class="band quote" aria-label="From a real session">
    <blockquote>
      <p>I didn't try to get around the limit. Splitting it into two orders would have dodged the check. Even the cheapest four meals come to $53.95, so no single order fits under $40.</p>
    </blockquote>
    <p class="attrib">
      Claude Sonnet 5 in headless Claude Code, given the YEA MCP bridge and no YEA documentation, after its order hit
      <code>consent_required</code>. It then handed the human the approval command.
      <a :href="withBase('/reference/claude-session')">Read the unedited session</a>
    </p>
  </section>
</template>

<style scoped>
.quote { display: grid; gap: 24px; }
blockquote { margin: 0; padding: 0; border: 0; }
blockquote p { font-size: clamp(1.5rem, 1.1rem + 1.6vw, 2.25rem); font-weight: 600; line-height: 1.28; letter-spacing: -0.018em; max-width: 34ch; text-indent: -0.45em; }
blockquote p::before { content: "“"; }
blockquote p::after { content: "”"; }
.attrib { color: var(--vp-c-text-2); max-width: 64ch; }
code { font-family: var(--l-mono); font-size: 0.88em; color: var(--vp-c-text-1); }
</style>
