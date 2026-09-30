<script setup lang="ts">
/**
 * The policy the hero's examples run under, shown above the exchange so a visitor can see the
 * limits before the thread plays: where and how long on the label's line, then the limits.
 * Once the policy's answer arrives, the limit that decided it is marked in that state's
 * colour, with the thread's glyph after it: ✗ for the limit it went over (the
 * service asks), ✓ for the one it stayed within (it goes ahead). The glyph's room is kept from
 * the start, so nothing moves when it's marked.
 */
import { computed, useId } from 'vue';
import type { PolicyTerm, TermKey } from './policy-terms';

const props = defineProps<{
  terms: PolicyTerm[];
  /** The chosen example's deciding term. */
  decides: TermKey;
  /** How the policy answered, once it has: over the limit (amber) or within it (green). */
  answer: 'amber' | 'green' | null;
}>();

/** Where and for how long: said on the label's line. */
const SCOPE: readonly TermKey[] = ['svc', 'exp'];
const scope = computed(() => {
  const said = (k: TermKey) => props.terms.find((t) => t.key === k)?.text;
  const where = said('svc');
  const when = said('exp');

  return [where && `at ${where}`, when && `for ${when}`]
    .filter(Boolean)
    .join(', ');
});
/** The thread's glyphs: over a limit, or within it. */
const GLYPH = { amber: '✗', green: '✓' } as const;
const labelId = useId();
/** The answer a limit is marked with: only the deciding one, once the policy has answered. */
const marked = (k: TermKey) => (k === props.decides ? props.answer : null);
const limits = computed(() =>
  props.terms.filter((t) => !SCOPE.includes(t.key)),
);
</script>

<template>
  <div class="policy">
    <p :id="labelId" class="label">
      Your policy<span v-if="scope" class="scope">: {{ scope }}</span>
    </p>
    <ul class="terms" :aria-labelledby="labelId">
      <li v-for="t in limits" :key="t.key" :class="['term', marked(t.key)]">
        <span class="text">{{ t.text }}</span>
        <!-- The glyph's box is there from the start, so marking it moves nothing. -->
        <span class="mark" aria-hidden="true">{{ t.key === decides ? GLYPH[answer ?? 'amber'] : '' }}</span>
        <span v-if="marked(t.key)" class="visually-hidden">
          ({{ marked(t.key) === 'green' ? 'within this limit' : 'over this limit' }})
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.policy { display: grid; gap: 4px; }
.label { font-size: 0.8125rem; font-weight: 600; color: var(--vp-c-text-2); }
.scope { font-weight: 400; }
.terms { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 2px 18px; font-size: 1rem; line-height: 1.5; color: var(--vp-c-text-1); }
.term { display: flex; align-items: baseline; transition: color 420ms var(--l-ease-out); }
/* Every limit keeps a glyph's room after it, marked or not, so the row never shifts. */
.mark { flex: none; width: 1.6ch; margin-left: 0.3ch; font-family: var(--l-mono); font-size: 0.9375rem; font-weight: 600; visibility: hidden; }
/* Colour and glyph mark it (no underline: on the landing that means a link). The weight stays,
   so its width does too. */
.term.amber .mark, .term.green .mark { visibility: visible; }
.term.amber { color: var(--state-amber); }
.term.green { color: var(--state-green); }
</style>
