<script setup lang="ts">
/**
 * Cost per task, REST MCP against YEA, as a table of paired bars on one zero-based scale:
 * each value is labelled, and the table is the accessible view of the chart.
 */
import { costRows, dollars } from './evidence';
import { LIVE } from './numbers';

const rows = costRows(LIVE.tasks);
</script>

<template>
  <figure class="chart">
    <figcaption class="legend">
      <span class="key rest">REST MCP, unrestricted credential</span>
      <span class="key yea">YEA, a grant with the rules</span>
      <span>Bars start at $0.</span>
    </figcaption>
    <table>
      <caption class="visually-hidden">Median cost per task over {{ LIVE.runs }} runs, REST MCP and YEA</caption>
      <thead>
        <tr><th scope="col">Task</th><th scope="col">Median cost per task</th><th scope="col">Difference</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.task">
          <th scope="row">{{ r.task }}</th>
          <td>
            <div class="pair">
              <span class="arm">REST</span>
              <span class="track"><span class="bar rest" :style="{ width: `${r.restBar}%` }" /></span>
              <span class="val">{{ dollars(r.rest) }}</span>
              <span class="arm">YEA</span>
              <span class="track"><span class="bar yea" :style="{ width: `${r.yeaBar}%` }" /></span>
              <span class="val">{{ dollars(r.yea) }}</span>
            </div>
          </td>
          <td class="delta">{{ r.delta }}</td>
        </tr>
      </tbody>
    </table>
  </figure>
</template>

<style scoped>
.chart { margin: 0; display: grid; gap: 16px; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 24px; font-size: 0.9375rem; color: var(--vp-c-text-2); }
.key::before { content: ""; display: inline-block; width: 14px; height: 10px; border-radius: 0 3px 3px 0; margin-right: 8px; vertical-align: 0; }
.key.rest::before { background: var(--vp-c-text-3); }
.key.yea::before { background: var(--vp-c-text-1); }

table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 0.9375rem; }
thead th:first-child { width: 36%; }
thead th:last-child { width: 5.5rem; }
thead th { text-align: left; font-size: 0.8125rem; font-weight: 600; color: var(--vp-c-text-2); padding: 0 0 10px; border-bottom: 1px solid var(--vp-c-divider); }
thead th:last-child { text-align: right; }
tbody th, tbody td { padding: 16px 0; border-bottom: 1px solid var(--vp-c-divider); vertical-align: middle; }
tbody th { text-align: left; font-weight: 500; padding-right: 24px; }
.pair { display: grid; grid-template-columns: 3.2rem minmax(0, 1fr) 4rem; align-items: center; gap: 4px 10px; }
.arm { font-size: 0.8125rem; font-weight: 600; color: var(--vp-c-text-2); }
.track { display: block; height: 10px; }
.bar { display: block; height: 100%; border-radius: 0 4px 4px 0; }
.bar.rest { background: var(--vp-c-text-3); }
.bar.yea { background: var(--vp-c-text-1); }
.val { font-size: 0.875rem; text-align: right; font-variant-numeric: tabular-nums; }
.delta { text-align: right; font-size: 0.9375rem; font-weight: 650; font-variant-numeric: tabular-nums; padding-left: 16px; white-space: nowrap; }

@media (max-width: 640px) {
  thead { display: none; }
  tbody tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; padding: 16px 0; border-bottom: 1px solid var(--vp-c-divider); }
  tbody th, tbody td { display: block; padding: 0; border: 0; width: auto; }
  tbody td:first-of-type { grid-column: 1 / -1; grid-row: 2; }
  .delta { grid-row: 1; grid-column: 2; }
}
</style>
