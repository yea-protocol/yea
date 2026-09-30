<script setup lang="ts">
/**
 * The hero's background, drawn from the exchange itself: a line from each message of the
 * thread (as it arrives) converges on the approval point at the slip's perforation; the
 * proposals the agent didn't pick branch off the proposals' line and stop short; and past the
 * slip one line continues, turning green once the action is committed. The point and that line
 * appear with the slip. The lines keep to the gutter between thread and slip, so they never
 * cross text, and on one column there are none. Decoration: hidden from assistive technology,
 * absent without JavaScript.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { branches, converge, type Point } from './junction';
import type { Tone } from './tone';

const props = defineProps<{
  /** How many messages have arrived; their lines are drawn in. */
  lit: number;
  /** How many proposals the agent didn't pick. */
  passed: number;
  /** The state the approval point shows. */
  tone: Tone;
  /** Whether the slip is here. */
  landed: boolean;
}>();

/** Wide enough for the thread and the slip to sit side by side, with lines between. */
const SIDE_BY_SIDE = '(min-width: 960px)';
/** The proposals message, whose line the branches leave from. */
const PROPOSALS = 2;
/** The slip's arrival (ProposalSlip.vue), after which it sits where it will stay. */
const ARRIVAL_MS = 480;

const svg = ref<SVGSVGElement | null>(null);
const size = ref({ w: 0, h: 0 });
const point = ref<Point | null>(null);
const exit = ref<Point | null>(null);
const said = ref<string[]>([]);
const forks = ref<{ d: string; end: Point }[]>([]);
let observer: ResizeObserver | undefined;
let settle: ReturnType<typeof setTimeout> | undefined;

/** Where an element is in the band, ignoring transforms (the slip arrives sliding up). */
function layoutBox(el: HTMLElement, band: HTMLElement) {
  let x = 0;
  let y = 0;

  for (
    let n: Element | null = el;
    n instanceof HTMLElement && n !== band;
    n = n.offsetParent
  ) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }

  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/**
 * Where a message's line starts: just past the end of its label (who says it to whom). The label
 * row has nothing else on it, so the line runs level from there to the gutter without crossing
 * text, then turns into the approval point.
 */
function labelEnd(dot: HTMLElement, band: HTMLElement, gutter: number) {
  const label = dot.parentElement;
  const walk = label && document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let right = 0;

  // The text's own boxes: the label's box runs the column's full width.
  while (walk?.nextNode()) {
    range.selectNodeContents(walk.currentNode);

    for (const r of range.getClientRects()) {
      right = Math.max(right, r.right);
    }
  }

  const x = right - band.getBoundingClientRect().left + 12;

  return right ? Math.min(gutter, x) : gutter;
}

function measure() {
  const band = svg.value?.parentElement;
  const side = band?.querySelector<HTMLElement>('.side');
  const slip = band?.querySelector<HTMLElement>('.slip');
  const stub = slip?.querySelector<HTMLElement>('.stub');

  if (!band || !side || !slip || !stub) {
    return;
  }

  const s = layoutBox(slip, band);
  const y = layoutBox(stub, band).y;
  const at = { x: s.x, y };
  const s0 = layoutBox(side, band);
  // The gutter's near edge, just past the thread; on one column there's no gutter.
  const x0 = s0.x + s0.w + 12;
  const wide = matchMedia(SIDE_BY_SIDE).matches && at.x - x0 > 40;
  const starts = wide
    ? [...band.querySelectorAll<HTMLElement>('[data-junction]')].map((d) => ({
        lead: labelEnd(d, band, x0),
        x: x0,
        y: layoutBox(d, band).y + d.offsetHeight / 2,
      }))
    : [];

  size.value = { w: band.offsetWidth, h: band.offsetHeight };
  point.value = wide ? at : null;
  exit.value = wide ? { x: s.x + s.w, y } : null;
  // A level leader from the label to the gutter, then the curve into the point.
  said.value = starts.map(
    (p) =>
      `M${Math.round(p.lead)} ${Math.round(p.y)} L${converge(p, at).slice(1)}`,
  );
  forks.value =
    wide && starts[PROPOSALS]
      ? branches(starts[PROPOSALS], props.passed, (at.x - x0) * 0.6)
      : [];
}

onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);

  const band = svg.value?.parentElement;

  if (band) {
    observer.observe(band);
  }

  // The fonts arriving can move the thread's dots without resizing the band.
  void document.fonts?.ready.then(measure);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  clearTimeout(settle);
});

watch(
  () => [props.lit, props.passed, props.landed],
  () => {
    measure();
    clearTimeout(settle);
    settle = setTimeout(measure, ARRIVAL_MS);
  },
  { flush: 'post' },
);
</script>

<template>
  <svg ref="svg" class="junction" :viewBox="`0 0 ${size.w} ${size.h}`" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <g class="said">
      <path v-for="(d, i) in said" :key="`m${i}`" :d="d" pathLength="1" :class="{ on: i < lit }" />
    </g>
    <g :class="['forks', { on: lit > PROPOSALS }]">
      <template v-for="(f, i) in forks" :key="`f${i}`">
        <path :d="f.d" />
        <circle :cx="f.end.x" :cy="f.end.y" r="3.5" />
      </template>
    </g>
    <template v-if="point && exit && landed">
      <line :class="['onward', { on: tone === 'green' }]" :x1="exit.x" :y1="exit.y" :x2="size.w" :y2="exit.y" pathLength="1" />
      <circle :class="['point', tone]" :cx="point.x" :cy="point.y" r="9" />
      <circle v-if="tone !== 'plain'" :key="tone" :class="['ring', tone]" :cx="point.x" :cy="point.y" r="9" />
    </template>
  </svg>
</template>

<style scoped>
/* Above the state wash (the field), below the exchange's own content. */
.junction { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
path, line { fill: none; stroke-linecap: round; }

/* Each message's line draws in as it arrives. */
.said path { stroke: var(--vp-c-text-2); stroke-opacity: 0.5; stroke-width: 1.25; stroke-dasharray: 1; stroke-dashoffset: 1; transition: stroke-dashoffset 900ms var(--l-ease-out); }
.said path.on { stroke-dashoffset: 0; }

/* The proposals not picked: faint, dashed, and they stop at an open end. */
.forks { opacity: 0; transition: opacity 600ms var(--l-ease-out); }
.forks.on { opacity: 1; }
.forks path { stroke: var(--vp-c-text-3); stroke-opacity: 0.55; stroke-width: 1; stroke-dasharray: 3 4; }
.forks circle { fill: var(--vp-c-bg); stroke: var(--vp-c-text-3); stroke-width: 1; }

/* The one action that continues: dashed while it waits, drawn green once committed. */
.onward { stroke: var(--vp-c-text-3); stroke-opacity: 0.5; stroke-width: 1.25; stroke-dasharray: 0.012 0.012; }
.onward.on { stroke: var(--state-green); stroke-opacity: 1; stroke-width: 2; stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 900ms var(--l-ease-out) forwards; }
@keyframes draw { to { stroke-dashoffset: 0; } }

/* The approval point sits on the slip's left notch; it takes the state at full strength. */
.point { fill: var(--vp-c-bg); stroke: var(--vp-c-text-3); stroke-width: 1.5; transition: fill 300ms var(--l-ease-out), stroke 300ms var(--l-ease-out); }
.point.amber { fill: var(--amber); stroke: var(--state-amber); }
.point.green { fill: var(--green); stroke: var(--state-green); }
.point.red { fill: var(--red); stroke: var(--state-red); }
/* One pulse when it lands on a state. */
.ring { fill: none; stroke-width: 2; transform-box: fill-box; transform-origin: center; animation: pulse 1100ms var(--l-ease-out) forwards; }
.ring.amber { stroke: var(--amber); }
.ring.green { stroke: var(--green); }
.ring.red { stroke: var(--red); }
@keyframes pulse { from { transform: scale(1); opacity: 0.9; } to { transform: scale(3.2); opacity: 0; } }
</style>
