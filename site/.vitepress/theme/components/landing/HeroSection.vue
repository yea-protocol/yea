<script setup lang="ts">
/**
 * The hero: the protocol in two sentences, and a real proposal the visitor approves, then
 * undoes, on the core running in the page. The ask above the slip is worked out from the
 * recorded proposal and the example policy, so it can't disagree with them.
 */
import { withBase } from 'vitepress';
import { RECORDED } from './exchange';
import ProposalSlip from './ProposalSlip.vue';
import { amount, landingCaveats } from './policy';

const REPO = 'https://github.com/yea-protocol/yea';

const spend = /([\d.]+) USD/.exec(RECORDED.slip.uses)?.[1];
const each = landingCaveats(0).find((c) => 'each' in c);
const limit = each && 'each' in each ? amount(each.each) : '';
</script>

<template>
  <section class="hero" aria-labelledby="hero-title">
    <div class="copy">
      <h1 id="hero-title">HTTP was built for browsers. YEA is built for agents.</h1>
      <p class="lede">
        YEA (Your Explicit Approval) is an open protocol for AI agents acting on behalf of people. A service answers an
        agent with proposals that list their effects before anything happens. A policy the person signs decides what goes
        ahead on its own; anything past it waits for their yes.
      </p>
      <div class="actions">
        <a class="btn primary" :href="withBase('/playground')">Open the playground</a>
        <a class="btn" :href="withBase('/guide/quickstart')">Quickstart</a>
        <a :href="REPO">GitHub</a>
      </div>
    </div>

    <div class="demo">
      <p class="ask">Your agent wants to spend ${{ spend }}. Your policy allows {{ limit }} per action, so the shop asks you.</p>
      <ProposalSlip />
      <p class="note">
        A real proposal from the example shop, made by the protocol core running in this page. Approving signs with a key
        your browser just made; nothing is sent anywhere.
      </p>
    </div>
  </section>
</template>

<style scoped>
.hero { max-width: var(--l-wide); margin: 0 auto; display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: clamp(40px, 6vw, 88px); align-items: center; padding: clamp(48px, 7vw, 104px) 0 clamp(64px, 8vw, 112px); }
.copy { display: grid; gap: 28px; align-content: center; }
h1 { font-size: clamp(2.5rem, 1.6rem + 3.4vw, 4.25rem); font-weight: 750; line-height: 1.02; letter-spacing: -0.032em; }
.lede { font-size: 1.1875rem; line-height: 1.55; color: var(--vp-c-text-2); max-width: 44ch; }
.demo { display: grid; gap: 14px; }
.ask { font-size: 1.0625rem; font-weight: 650; line-height: 1.4; max-width: 40ch; }
.note { font-size: 0.9375rem; color: var(--vp-c-text-2); max-width: 60ch; }

@media (max-width: 960px) {
  .hero { grid-template-columns: 1fr; gap: 48px; }
}
</style>
