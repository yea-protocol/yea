<script setup lang="ts">
/**
 * The hero: the protocol in two sentences, and a real proposal the visitor approves, then
 * undoes, on the core running in the page. The ask above the slip is worked out from the
 * recorded proposal and the example policy, so it can't disagree with them.
 *
 * The whole band takes the slip's state colour (tone.ts): amber while the proposal waits on
 * the visitor, green once they approve, and the new colour spreads from the button they
 * pressed (use-flood.ts).
 */
import { withBase } from 'vitepress';
import { computed, ref, useTemplateRef } from 'vue';
import { RECORDED } from './exchange';
import ProposalSlip from './ProposalSlip.vue';
import { amount, landingCaveats } from './policy';
import { phaseTone } from './tone';
import { useFlood } from './use-flood';
import type { Phase } from './use-slip';

const REPO = 'https://github.com/yea-protocol/yea';

const each = landingCaveats(0).find((c) => 'each' in c);
const limit = each && 'each' in each ? amount(each.each) : '';

const phase = ref<Phase>('loading');
const tone = computed(() => phaseTone(phase.value));
const { base, flood, press, ended } = useFlood(
  tone,
  useTemplateRef<HTMLElement>('band'),
);
</script>

<template>
  <section ref="band" class="hero-band l-bleed" :data-tone="tone" :data-base="base" aria-labelledby="hero-title" @click.capture="press">
    <span
      v-if="flood"
      :key="flood.key"
      :data-key="flood.key"
      class="flood"
      :style="{ '--x': `${flood.x}px`, '--y': `${flood.y}px`, '--r': `${flood.r}px` }"
      aria-hidden="true"
      @animationend="ended"
      @animationcancel="ended"
    />
    <div class="hero">
      <div class="copy on-band">
        <h1 id="hero-title"><span class="sentence">Your agent proposes.</span> <span class="sentence">You decide what goes ahead.</span></h1>
        <p class="lede">
          YEA (Your Explicit Approval) is an open protocol for AI agents acting on behalf of people. A service answers an
          agent with proposals that list their effects before anything happens. A policy the person signs decides what goes
          ahead on its own; anything past it waits for their yes.
        </p>
        <div class="actions">
          <a class="btn primary" :href="withBase('/playground')">Try it in the playground</a>
          <a class="btn" :href="withBase('/guide/mcp-typescript')">Add it to your MCP server</a>
        </div>
        <p class="aside">
          Unreleased: the MCP server framework installs from the repo. Guides for
          <a :href="withBase('/guide/mcp-typescript')">TypeScript</a> and <a :href="withBase('/guide/mcp-python')">Python</a>;
          the code is on <a :href="REPO">GitHub</a>.
        </p>
      </div>

      <div class="demo">
        <p class="ask on-band">Your agent wants to spend ${{ RECORDED.spend.toFixed(2) }}. Your policy allows {{ limit }} per action, so the shop asks you.</p>
        <noscript><p class="note on-band">Approving runs the protocol core in your browser, which needs JavaScript. The exchange below is the same one, recorded.</p></noscript>
        <ProposalSlip @phase="phase = $event" />
        <p class="note on-band">
          A real proposal from the example shop, made by the protocol core running in this page. The page signed an example
          policy as you, with a key your browser just made, and nothing is sent anywhere.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* The band runs edge to edge; its colour is the settled tone (data-base), and a new tone
   (data-tone) spreads over it from the pressed button, then settles. */
.hero-band { --l-base: var(--vp-c-bg); --l-next: var(--vp-c-bg); --l-notch: var(--l-next); position: relative; isolation: isolate; overflow: hidden; background: var(--l-base); }
.hero-band[data-base="amber"] { --l-base: var(--amber); }
.hero-band[data-base="green"] { --l-base: var(--green); }
.hero-band[data-base="red"] { --l-base: var(--red); }
.hero-band[data-tone="amber"] { --l-next: var(--amber); }
.hero-band[data-tone="green"] { --l-next: var(--green); }
.hero-band[data-tone="red"] { --l-next: var(--red); }
.flood { position: absolute; inset: 0; z-index: -1; background: var(--l-next); clip-path: circle(0 at var(--x) var(--y)); animation: flood 900ms var(--l-ease-out) forwards; }
@keyframes flood { to { clip-path: circle(var(--r) at var(--x) var(--y)); } }

/* Text on a coloured band is ink in both themes (6.9:1 or more for secondary text on amber
   and green, 4.8:1 on red; button borders 3.3:1 or more); the slip keeps the theme's own
   colours. The text changes a beat after the spread starts, once the circle is reaching it. */
.hero-band:not([data-tone="plain"]) .on-band { --vp-c-text-1: var(--ink); --vp-c-text-2: rgb(11 13 18 / 0.78); --vp-c-text-3: rgb(11 13 18 / 0.55); --vp-c-border: rgb(11 13 18 / 0.6); --vp-c-bg: var(--l-next); --vp-c-brand-1: var(--ink); }
.on-band { color: var(--vp-c-text-1); }
.on-band, .on-band :where(h1, p, a, .btn) { transition: color 480ms var(--l-ease-out) 120ms, background-color 480ms var(--l-ease-out) 120ms, border-color 480ms var(--l-ease-out) 120ms; }

.hero { max-width: var(--l-wide); margin: 0 auto; display: grid; grid-template-columns: minmax(0, 11fr) minmax(0, 12fr); gap: clamp(40px, 6vw, 88px); align-items: center; padding: clamp(48px, 7vw, 104px) 0 clamp(64px, 8vw, 112px); }
.copy { display: grid; gap: 28px; align-content: center; }
/* Big, but a step below the slip's weight: two or three lines at 1440, not four heavy ones. */
h1 { font-size: clamp(2.25rem, 1.75rem + 1.6vw, 3.125rem); font-weight: 650; line-height: 1.06; letter-spacing: -0.026em; }
h1 .sentence { display: block; }
.aside { font-size: 0.9375rem; color: var(--vp-c-text-2); margin-top: -12px; max-width: 46ch; }
.lede { font-size: 1.1875rem; line-height: 1.55; color: var(--vp-c-text-2); max-width: 44ch; }
.demo { display: grid; gap: 14px; }
.ask { font-size: 1.0625rem; font-weight: 650; line-height: 1.4; max-width: 40ch; }
.note { font-size: 0.9375rem; color: var(--vp-c-text-2); max-width: 60ch; }

@media (max-width: 960px) {
  .hero { grid-template-columns: 1fr; gap: 48px; }
}
</style>
