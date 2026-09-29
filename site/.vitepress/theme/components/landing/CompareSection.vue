<script setup lang="ts">
/**
 * How YEA compares with REST/HTTP APIs and MCP. The row names stay in view while the table
 * scrolls sideways; on a phone each row stacks into labelled lines.
 */
import { COMPARE_COLUMNS, COMPARE_ROWS } from './compare';
</script>

<template>
  <section class="band" aria-labelledby="compare-title">
    <div class="band-intro">
      <h2 id="compare-title">How it compares</h2>
    </div>
    <div class="wrap" tabindex="0" role="region" aria-label="Comparison table; scrolls sideways on narrow screens">
      <table role="table">
        <thead role="rowgroup">
          <tr role="row">
            <th role="columnheader" scope="col"><span class="visually-hidden">Concern</span></th>
            <th v-for="c in COMPARE_COLUMNS" :key="c" role="columnheader" scope="col">{{ c }}</th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          <tr v-for="[concern, ...cells] in COMPARE_ROWS" :key="concern" role="row">
            <th role="rowheader" scope="row">{{ concern }}</th>
            <td v-for="(cell, i) in cells" :key="i" role="cell" :data-label="COMPARE_COLUMNS[i]" :class="{ us: i === 2 }">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="prose after">
      YEA doesn't replace MCP as an integration layer; the bridge runs on MCP. It replaces what MCP servers usually wrap: an
      API designed for code rather than for delegated agents.
    </p>
  </section>
</template>

<style scoped>
.wrap { overflow-x: auto; border: 1px solid var(--vp-c-divider); border-radius: 12px; }
table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 760px; font-size: 0.9375rem; }
th, td { text-align: left; vertical-align: top; padding: 14px 18px; border-bottom: 1px solid var(--vp-c-divider); }
tbody tr:last-child > * { border-bottom: 0; }
thead th { font-size: 0.8125rem; font-weight: 600; color: var(--vp-c-text-2); background: var(--vp-c-bg-alt); }
th[scope="row"], thead th:first-child { position: sticky; left: 0; z-index: 1; background: var(--vp-c-bg-alt); box-shadow: 1px 0 0 var(--vp-c-divider); }
th[scope="row"] { font-weight: 650; width: 18%; }
td { color: var(--vp-c-text-2); }
td.us { color: var(--vp-c-text-1); font-weight: 500; }
.after { margin-top: 24px; }

@media (max-width: 640px) {
  .wrap { overflow: visible; border: 0; border-radius: 0; }
  table, tbody, tr, th, td { display: block; min-width: 0; }
  thead { display: none; }
  tr { padding: 16px 0; border-bottom: 1px solid var(--vp-c-divider); }
  th, td { padding: 4px 0; border: 0; }
  th[scope="row"] { position: static; background: none; box-shadow: none; width: auto; font-size: 1.0625rem; margin-bottom: 4px; }
  td::before { content: attr(data-label); display: block; font-size: 0.8125rem; font-weight: 600; color: var(--vp-c-text-2); }
}
</style>
