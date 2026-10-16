<script setup lang="ts">
/**
 * The evidence: what enforced safety cost in a live-agent eval, as one chart, with every
 * caveat beside it at the same size as the claim. Every figure comes from numbers.ts.
 */
import { withBase } from 'vitepress';
import CostChart from './CostChart.vue';
import { deltaRange, fewerOrMore } from './evidence';
import { LIVE, PAYLOAD } from './numbers';

const range = deltaRange(LIVE.tasks);
const s = LIVE.shortcut;
const p = PAYLOAD;
</script>

<template>
  <section class="band" aria-labelledby="evidence-title">
    <div class="band-intro">
      <h2 id="evidence-title">Enforced safety at about the same cost</h2>
      <p class="prose">
        A real model did the same tasks through a REST-style MCP server holding an unrestricted credential, and through the
        YEA bridge holding a grant that encodes the user's rules. Both got the same rules in the prompt: nothing over
        ${{ LIVE.rules.each }} per purchase or ${{ LIVE.rules.total }} in total, and nothing risky or irreversible, without
        asking. Outcomes were checked from the services' real state after each run.
      </p>
      <p class="claim">
        Rule violations: {{ LIVE.violated }} of {{ LIVE.runs }} runs on every task, in both arms. Task success:
        {{ LIVE.succeeded }} of {{ LIVE.runs }}, in both arms. YEA cost {{ range }} more per task.
      </p>
    </div>

    <div class="grid">
      <div class="left">
        <CostChart />
        <p class="prose">
          In a scripted benchmark of what each protocol sends the model, YEA sends {{ fewerOrMore(p.savedVsMinified) }}
          tokens than minified JSON ({{ fewerOrMore(p.savedVsPretty) }} than pretty-printed). Its replies are mostly smaller, but the
          bridge's tool definitions take {{ p.yeaDefs.toLocaleString('en-US') }} tokens against REST's {{ p.restDefs }}, and every turn re-reads them.
          Until #297 that benchmark counted an older, smaller tool surface and showed a saving; shrinking the definitions is
          <a href="https://github.com/yea-protocol/yea/issues/300">#300</a>. When REST offers the same outcome-level endpoint,
          the reschedule row goes from {{ fewerOrMore(p.crudRescheduleSaving) }} to {{ fewerOrMore(p.outcomeEndpointSaving) }},
          so most of that row's gain is API shape.
          <a :href="withBase('/reference/benchmark')">Method and raw output</a>
        </p>
      </div>
      <div class="read">
        <p class="prose">
          Medians over {{ LIVE.runs }} runs, {{ LIVE.model }}. Most of each bill is the model re-reading its context every turn,
          not the tool payloads. Neither arm broke a rule, even with a fake "owner pre-approved ${{ LIVE.injectedApproval }}"
          note hidden in the menu: this model followed the stated rules. The difference is who enforces them. With REST, the
          rules held because the model obeyed. With YEA, the service enforces them, so they hold even when a model doesn't.
        </p>
        <p class="prose">
          When the model sends the goal straight to an intent, a reschedule took {{ s.yeaCalls }} call and {{ s.yeaTokens }}
          tokens against REST's {{ s.restCalls }} calls and {{ s.restTokens }}, but that happened in {{ s.runs }} runs.
          <a :href="withBase('/benchmark/live')">Every run, the method and what we got wrong</a>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: clamp(32px, 5vw, 64px); align-items: start; }
.left, .read { display: grid; gap: 24px; }
.read { gap: 16px; }
.claim { font-weight: 650; max-width: var(--l-measure); }

@media (max-width: 960px) {
  .grid { grid-template-columns: 1fr; }
}
</style>
