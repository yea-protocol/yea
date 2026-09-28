<script setup lang="ts">
/**
 * The evidence: what enforced safety cost in a live-agent eval, as one chart, with every
 * caveat beside it at the same size as the claim, and the payload result in a sentence.
 */
import { withBase } from 'vitepress';
import CostChart from './CostChart.vue';
import { deltaRange } from './evidence';
import { LIVE, PAYLOAD } from './numbers';

const range = deltaRange(LIVE.tasks);
const s = LIVE.shortcut;
</script>

<template>
  <section class="band" aria-labelledby="evidence-title">
    <div class="band-intro">
      <h2 id="evidence-title">Enforced safety at about the same cost</h2>
      <p class="prose">
        A real model did the same tasks through a REST-style MCP server holding an unrestricted credential, and through the
        YEA bridge holding a grant that encodes the user's rules. Both got the same rules in the prompt: nothing over $40 per
        purchase or $100 in total, and nothing risky or irreversible, without asking. Outcomes were checked from the
        services' real state after each run.
      </p>
    </div>

    <div class="grid">
      <CostChart />
      <div class="read">
        <p class="claim">
          Rule violations: 0 in every run, in both arms. Task success: {{ LIVE.success }} on every task, in both arms. YEA cost
          {{ range }} more per task.
        </p>
        <p class="prose">
          Medians over {{ LIVE.runs }} runs, {{ LIVE.model }}. Most of each bill is the model re-reading its context every turn,
          not the tool payloads. Neither arm broke a rule, even with a fake "owner pre-approved $200" note hidden in the menu:
          this model followed the stated rules. The difference is who enforces them. With REST, the rules held because the
          model obeyed. With YEA, the service enforces them, so they hold even when a model doesn't.
        </p>
        <p class="prose">
          When the model sends the goal straight to an intent, a reschedule took {{ s.yeaCalls }} call and {{ s.yeaTokens }}
          tokens against REST's {{ s.restCalls }} calls and {{ s.restTokens }}, but that happened in {{ s.runs }} runs.
          <a :href="withBase('/benchmark/live')">Every run, the method and what we got wrong</a>
        </p>
        <p class="prose">
          Replies are {{ PAYLOAD.smallerThanMinified }}% smaller than minified JSON across a scripted benchmark
          ({{ PAYLOAD.smallerThanPretty }}% against pretty-printed), but in live use that saving is outweighed by the context
          each turn re-reads, so it doesn't lower the bill on its own. When REST offers the same outcome-level endpoint, the
          reschedule saving drops to {{ PAYLOAD.outcomeEndpointSaving }}%.
          <a :href="withBase('/reference/benchmark')">Method and raw output</a>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: clamp(32px, 5vw, 64px); align-items: start; }
.read { display: grid; gap: 16px; }
.claim { font-weight: 650; }

@media (max-width: 960px) {
  .grid { grid-template-columns: 1fr; }
}
</style>
