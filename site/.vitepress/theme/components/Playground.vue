<script setup lang="ts">
/**
 * The YEA playground: the real protocol core and example services, running in the page.
 * You play the agent (left); the right shows exactly what a model would read.
 * This file lays the parts out; they and their state live in playground/.
 */
import { computed } from 'vue';
import ConsentCard from './playground/ConsentCard.vue';
import HistoryList from './playground/HistoryList.vue';
import { lensView } from './playground/lens-lines';
import PolicyPanel from './playground/PolicyPanel.vue';
import PresetBar from './playground/PresetBar.vue';
import QuickActions from './playground/QuickActions.vue';
import ReplyPane from './playground/ReplyPane.vue';
import RequestPane from './playground/RequestPane.vue';
import { usePlayground } from './playground/use-playground';

const pg = usePlayground();
const {
  core,
  failed,
  log,
  selected,
  busy,
  current,
  policy,
  grant,
  grantInfo,
  form,
  paramsError,
  caps,
  targets,
} = pg;
const { pickCapability, parsedParams, send, act, choose, runPreset } = pg;
const {
  request: consent,
  message: consentMessage,
  facts: consentFacts,
  check: consentCheck,
  approve,
} = pg.consent;

const view = computed(() =>
  current.value && core.value ? lensView(core.value, current.value) : null,
);

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    void send();
  }
}
</script>

<template>
  <div class="pg" @keydown="onKey">
    <header class="pg-head">
      <div>
        <h1>Playground</h1>
        <p>
          You're the agent. A calendar, a meal shop and a billing system run in this page on the real YEA core, and your requests are
          signed with a grant from the human's policy. The right side shows exactly what a model would read.
        </p>
      </div>
      <PresetBar @preset="runPreset" />
    </header>

    <p v-if="failed" class="fatal">The playground couldn't start: {{ failed }}. It needs a browser with Ed25519 in WebCrypto (current Chrome, Firefox or Safari).</p>
    <p v-else-if="!core" class="loading">Starting the services…</p>

    <div v-else class="grid">
      <RequestPane :form="form" :caps="caps" :targets="targets" :busy="busy" :params-error="paramsError" @pick-capability="pickCapability" @check-params="parsedParams()" @send="send()">
        <PolicyPanel :policy="policy" :grant="grant" :grant-info="grantInfo" />
      </RequestPane>

      <section class="pane out" aria-label="What the model reads" aria-live="polite">
        <template v-if="current">
          <ReplyPane v-if="view" :exchange="current" :view="view" />
          <ConsentCard v-if="consent" :message="consentMessage" :service="consent.service" :check="consentCheck" :facts="consentFacts" @approve="approve()" />
          <QuickActions v-else :exchange="current" @act="act" @choose="choose" />
        </template>

        <HistoryList :log="log" :active="current ? current.n : null" @select="selected = $event" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.pg { max-width: 1360px; margin: 0 auto; padding: 32px 24px 80px; }
.pg-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: end; margin-bottom: 24px; }
.pg-head h1 { font-family: var(--font-head); font-size: 2rem; font-weight: 600; margin: 0 0 8px; }
.pg-head p { color: var(--vp-c-text-2); max-width: 70ch; margin: 0; line-height: 1.55; }
.loading, .fatal { color: var(--vp-c-text-2); padding: 48px 0; }
.fatal { color: var(--state-red); }

.grid { display: grid; grid-template-columns: 400px minmax(0, 1fr); gap: 20px; align-items: start; }
.pane { background: var(--vp-c-bg-elv); border: 1px solid var(--vp-c-divider); border-radius: 14px; }
.out { padding: 0; overflow: hidden; }

@media (max-width: 980px) {
  .pg-head { grid-template-columns: 1fr; }
  .grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .pg { padding: 20px 16px 64px; }
}
</style>
