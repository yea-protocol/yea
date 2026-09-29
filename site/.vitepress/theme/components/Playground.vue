<script setup lang="ts">
/**
 * The YEA playground: the real protocol core and example services, running in the page.
 * You play the agent (left); the right shows exactly what a model would read.
 * This file lays the parts out; they and their state live in playground/.
 */
import { computed, ref, useId, useTemplateRef, watch } from 'vue';
import ConsentCard from './playground/ConsentCard.vue';
import HistoryList from './playground/HistoryList.vue';
import LoadingPanes from './playground/LoadingPanes.vue';
import { replySummary, requestSummary } from './playground/labels';
import { lensView } from './playground/lens-view';
import PolicyPanel from './playground/PolicyPanel.vue';
import PresetBar from './playground/PresetBar.vue';
import QuickActions from './playground/QuickActions.vue';
import ReplyPane from './playground/ReplyPane.vue';
import RequestPane from './playground/RequestPane.vue';
import { isSendShortcut } from './playground/shortcut';
import { usePlayground } from './playground/use-playground';
import { useReplyScroll } from './playground/use-reply-scroll';

const {
  core,
  failed,
  opened,
  log,
  selected,
  busy,
  current,
  send,
  policy,
  grant,
  grantInfo,
  form,
  paramsError,
  caps,
  targets,
  pickCapability,
  parsedParams,
  act,
  choose,
  runPreset,
  consentRequest,
  consentMessage,
  consentFacts,
  consentCheck,
  approveConsent,
} = usePlayground();

const view = computed(() =>
  current.value && core.value ? lensView(core.value, current.value) : null,
);

// The exchange the page opens on isn't announced: the live region starts speaking at the
// first change of the exchange on show after that.
const announce = ref(false);

watch(
  current,
  () => {
    announce.value = opened.value;
  },
  { flush: 'sync' },
);

/**
 * One line for the live region: the exchange's number, what was sent and what came back.
 * The number makes a repeat of the same request and reply a change, so it is announced too.
 */
const status = computed(() => {
  const x = current.value;

  return announce.value && x
    ? `${x.n}. ${requestSummary(x.request)}: ${replySummary(x.reply)}`
    : '';
});
const replyHeading = useId();

useReplyScroll({
  count: () => log.value.length,
  enabled: () => opened.value,
  pane: useTemplateRef<HTMLElement>('replyPane'),
});

function onKey(e: KeyboardEvent) {
  if (isSendShortcut(e)) {
    void send();
  }
}
</script>

<template>
  <main class="pg" @keydown="onKey">
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
    <LoadingPanes v-else-if="!core" />

    <div v-else class="panes">
      <RequestPane :form="form" :caps="caps" :targets="targets" :busy="busy" :params-error="paramsError" @pick-capability="pickCapability" @check-params="parsedParams()" @send="send()">
        <PolicyPanel :policy="policy" :grant="grant" :grant-info="grantInfo" />
      </RequestPane>

      <section ref="replyPane" class="pane out" :aria-labelledby="replyHeading">
        <h2 :id="replyHeading" class="visually-hidden">What the model reads</h2>
        <template v-if="current">
          <ReplyPane v-if="view" :exchange="current" :view="view" />
          <ConsentCard v-if="consentRequest" :message="consentMessage" :service="consentRequest.service" :check="consentCheck" :facts="consentFacts" @approve="approveConsent()" />
          <QuickActions v-else :exchange="current" @act="act" @choose="choose" />
        </template>

        <HistoryList :log="log" :active="current ? current.n : null" @select="selected = $event" />
      </section>
    </div>

    <p class="visually-hidden" role="status">{{ status }}</p>
  </main>
</template>

<style scoped src="./playground/panes.css"></style>
<style scoped>
.pg { max-width: 1360px; margin: 0 auto; padding: 32px 24px 80px; }
.pg-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: end; margin-bottom: 24px; }
.pg-head h1 { font-family: var(--font-head); font-size: 2rem; font-weight: 750; margin: 0 0 8px; }
.pg-head p { color: var(--vp-c-text-2); max-width: 70ch; margin: 0; line-height: 1.55; }
.fatal { color: var(--state-red); padding: 48px 0; }

.out { padding: 0; overflow: hidden; scroll-margin-top: calc(var(--vp-nav-height) + 16px); }

@media (max-width: 980px) {
  .pg-head { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .pg { padding: 20px 16px 64px; }
}
</style>
