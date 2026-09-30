<script setup lang="ts">
/**
 * The hero: why the protocol matters in one sentence, then a real exchange the visitor watches and
 * takes part in, on the core running in the page. They pick an example (an order over the policy's
 * limit, a meeting cancellation over its risk ceiling, or a meeting move inside it); its
 * thread plays message by message (use-reveal.ts), then the slip arrives to approve, undo or
 * start again.
 *
 * Behind it, the junction paths (JunctionPaths.vue) converge on the approval point at the
 * slip's perforation. The exchange's field takes a wash of the slip's state (tone.ts) once it
 * arrives, and the new wash spreads from the button pressed or the approval point
 * (use-flood.ts); the headline stays on paper, and the full colour is kept for the slip, its
 * Approve and the approval point.
 */
import { withBase } from 'vitepress';
import { computed, nextTick, reactive, ref, useTemplateRef, watch } from 'vue';
import SegmentedRadio from '../playground/SegmentedRadio.vue';
import { approvalPoint, layoutBox } from './anchors';
import JunctionPaths from './JunctionPaths.vue';
import PolicyTerms from './PolicyTerms.vue';
import ProposalSlip from './ProposalSlip.vue';
import { landingCaveats } from './policy';
import { policyTerms } from './policy-terms';
import { SCENE_KEYS, SCENES, type SceneKey } from './scenes';
import Thread from './Thread.vue';
import { LEAD, thread } from './thread';
import { phaseTone, type Tone } from './tone';
import { useFlood } from './use-flood';
import { useReveal } from './use-reveal';
import { useSlip } from './use-slip';

const REPO = 'https://github.com/yea-protocol/yea';

const s = reactive(useSlip());
const band = useTemplateRef<HTMLElement>('band');
const messages = computed(() =>
  thread(s.progress, {
    approved: s.receipt
      ? { id: s.receipt.id, undoUntil: s.receipt.undoUntil }
      : null,
    undone: s.undone,
  }),
);
const { reveal, playing, landed, ready, replay, skip } = useReveal(
  computed(() => s.phase),
  useTemplateRef<HTMLElement>('area'),
  () => messages.value.length,
);
/** The last settled state, kept while a run is on its way with the slip still here. */
const held = ref(phaseTone(s.phase));

watch(
  () => s.phase,
  (p) => {
    if (p !== 'checking') {
      held.value = phaseTone(p);
    }
  },
);

const tone = computed<Tone>(() => (landed.value ? held.value : 'plain'));
const field = useTemplateRef<HTMLElement>('field');

/** The approval point in the field: where a change nobody pressed for spreads from. */
function anchor() {
  const at = band.value && approvalPoint(band.value);
  const f = band.value && field.value && layoutBox(field.value, band.value);

  return at && f ? { x: at.x - f.x, y: at.y - f.y } : null;
}

const { base, flood, press, ended } = useFlood(tone, field, anchor);

/**
 * A run the visitor started sends the slip away: keep their focus in the exchange meanwhile, on
 * Skip (visible, and pressing it brings the slip back), without scrolling the page.
 */
watch(landed, async (here) => {
  if (!here && document.activeElement?.closest('[data-slip]')) {
    await nextTick();
    band.value
      ?.querySelector<HTMLElement>('[data-playback]')
      ?.focus({ preventScroll: true });
  }
});

const OPTIONS = SCENE_KEYS.map((k) => ({ value: k, text: SCENES[k].label }));
const scene = computed<SceneKey>({
  get: () => s.scene,
  set: (k) => s.choose(k),
});
/** The example policy's terms: the same caveats the page signs, said shortly. */
const TERMS = policyTerms(landingCaveats(0), 0);
/** The policy's answer, once its message has arrived: over a limit (amber) or within (green). */
const answer = computed(() => {
  const lit = playing.value ? reveal.value : messages.value.length;
  const tone = messages.value[LEAD - 1]?.tone;

  return lit >= LEAD && (tone === 'amber' || tone === 'green') ? tone : null;
});
/** How many proposals the agent passed over, for the background's branches. */
const passed = computed(() =>
  Math.max(0, (s.progress.proposals?.count ?? 1) - 1),
);
</script>

<template>
  <section ref="band" class="hero-band l-bleed" :data-tone="tone" :data-base="base" :data-ready="ready || undefined" aria-labelledby="hero-title" @click.capture="press">
    <JunctionPaths :lit="playing ? reveal : messages.length" :passed="passed" :tone="tone" :landed="landed" />
    <div class="hero">
      <div class="intro">
        <div class="claim">
          <h1 id="hero-title"><span class="line">Let your agent act</span> <span class="line">without handing&nbsp;it the&nbsp;keys.</span></h1>
          <p class="aside">
            Unreleased: the MCP server framework installs from the repo. Guides for
            <a :href="withBase('/guide/mcp-typescript')">TypeScript</a> and <a :href="withBase('/guide/mcp-python')">Python</a>;
            the code is on <a :href="REPO">GitHub</a>.
          </p>
        </div>
        <div class="pitch">
          <p class="lede">
            YEA (Your Explicit Approval) is an open protocol for AI agents acting on behalf of people. Services answer an
            agent with proposals that list their effects first. Instead of an unrestricted credential, the agent carries a
            policy the person signed; anything past its limits waits for their yes.
          </p>
          <div class="actions">
            <a class="btn primary" :href="withBase('/playground')">Try it in the playground</a>
            <a class="btn" :href="withBase('/guide/mcp-typescript')">Add it to your MCP server</a>
          </div>
        </div>
      </div>

      <div ref="area" class="exchange">
        <!-- The state wash: behind the exchange only, faded in at its top edge. -->
        <div ref="field" class="field" aria-hidden="true">
          <span
            v-if="flood"
            :key="flood.key"
            :data-key="flood.key"
            class="flood"
            :style="{ '--x': `${flood.x}px`, '--y': `${flood.y}px`, '--r': `${flood.r}px` }"
            @animationend="ended"
            @animationcancel="ended"
          />
        </div>
        <div class="side" data-thread>
          <PolicyTerms :terms="TERMS" :decides="SCENES[scene].decides" :answer="answer" />
          <SegmentedRadio v-model="scene" class="scenes" label="Example" :options="OPTIONS" />
          <Thread :messages="messages" :reveal="reveal" :playing="playing" :ready="ready" @replay="replay" @skip="skip" />
        </div>
        <div class="demo">
          <noscript><p class="note">Running an example needs JavaScript: the protocol core runs in your browser. This is the dinner example, recorded.</p></noscript>
          <ProposalSlip :s="s" :away="!landed" />
          <!-- Said once the slip is here, so nothing is announced before it can be acted on. -->
          <p class="visually-hidden" role="status">{{ landed ? s.status : '' }}</p>
          <p class="note">
            Real proposals from example services, made by the protocol core running in this page with a key your browser
            just made; nothing is sent anywhere.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* The band runs edge to edge. Its wash is the settled tone (data-base); a new tone (data-tone)
   spreads over it from the pressed button, then settles. Text keeps the theme's colours. */
.hero-band { --l-base: var(--vp-c-bg); --l-next: var(--vp-c-bg); --l-notch: var(--l-next); --l-hero-end: clamp(64px, 8vw, 112px); position: relative; isolation: isolate; overflow: hidden; background: var(--vp-c-bg); }
.hero-band[data-base="amber"] { --l-base: var(--l-wash-amber); }
.hero-band[data-base="green"] { --l-base: var(--l-wash-green); }
.hero-band[data-base="red"] { --l-base: var(--l-wash-red); }
.hero-band[data-tone="amber"] { --l-next: var(--l-wash-amber); }
.hero-band[data-tone="green"] { --l-next: var(--l-wash-green); }
.hero-band[data-tone="red"] { --l-next: var(--l-wash-red); }
/* The field runs edge to edge behind the exchange, from just above it to the band's bottom,
   fading in at the top (a mask reads only alpha, so any opaque token will do). */
.field { position: absolute; z-index: -1; top: -72px; bottom: calc(-1 * var(--l-hero-end)); left: calc(50% - 50vw); right: calc(50% - 50vw); background: var(--l-base); overflow: hidden; mask-image: linear-gradient(to bottom, transparent, var(--ink) 72px); }
.flood { position: absolute; inset: 0; background: var(--l-next); clip-path: circle(0 at var(--x) var(--y)); animation: flood 900ms var(--l-ease-out) forwards; }
@keyframes flood { to { clip-path: circle(var(--r) at var(--x) var(--y)); } }

.hero { max-width: var(--l-wide); margin: 0 auto; display: grid; gap: clamp(24px, 2.5vw, 40px); padding: clamp(20px, 2.5vw, 40px) 0 var(--l-hero-end); }

/* The claim, then the pitch beside it. */
.intro { display: grid; grid-template-columns: minmax(0, 13fr) minmax(0, 10fr); gap: 20px clamp(40px, 6vw, 88px); align-items: start; }
h1 { font-size: clamp(2.25rem, 1.75rem + 1.6vw, 3.125rem); font-weight: 650; line-height: 1.06; letter-spacing: -0.026em; }
h1 .line { display: block; }
/* Wide enough for each half on its own line, as intended. */
@media (min-width: 1240px) {
  h1 .line { white-space: nowrap; }
}
.claim { display: grid; gap: 16px; align-content: start; }
.pitch { display: grid; gap: 16px; padding-top: 6px; }
.lede { font-size: 1.1875rem; line-height: 1.55; color: var(--vp-c-text-2); max-width: 64ch; }
.aside { font-size: 0.9375rem; color: var(--vp-c-text-2); max-width: 52ch; }

/* The exchange: the thread, a wide gutter the junction paths cross, and the slip. */
.exchange { position: relative; display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 40px clamp(48px, 9vw, 136px); align-items: start; }
.side { display: grid; gap: 24px; align-content: start; }
.demo { display: grid; gap: 16px; }
.scenes { --vp-c-bg-soft: transparent; border: 1px solid var(--vp-c-border); }
/* The chosen example is filled in the text colour, so it reads on every wash (3:1 and up). */
.scenes :deep([aria-checked="true"]) { background: var(--vp-c-text-1); color: var(--vp-c-bg); box-shadow: none; }
@media (forced-colors: active) {
  .scenes :deep([aria-checked="true"]) { outline: 2px solid Highlight; }
}
.note { font-size: 0.9375rem; color: var(--vp-c-text-2); max-width: 60ch; }

@media (max-width: 960px) {
  .intro, .exchange { grid-template-columns: 1fr; }
}
/* Phones: the examples stack, so none of their names breaks across lines. */
@media (max-width: 440px) {
  .scenes { flex-direction: column; }
}

</style>
