<script setup lang="ts">
/**
 * The human's policy: the services, risk, spend limits and lifetime of the grant, and the
 * grant it signs. Open to start with, except on a phone, where it would push Send's reply
 * a screen further down.
 */
import type { GrantInfo } from '@yea-protocol/sdk';
import { computed, ref } from 'vue';
import { caveatLines, type PolicyForm, shortGrant } from './grant';
import { matches, PHONE } from './viewport';

const props = defineProps<{
  policy: PolicyForm;
  grant: string;
  grantInfo: GrantInfo | null;
}>();

const short = computed(() => shortGrant(props.grant));
const caveats = computed(() => caveatLines(props.grantInfo));
const open = ref(!matches(PHONE));
</script>

<template>
  <details class="policy" :open="open" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary>The human's policy</summary>
    <p class="hint">Signed by the human's key and presented with every request. Change it and the grant is re-signed.</p>
    <div class="checks">
      <label><input v-model="policy.calendar" type="checkbox" /> calendar.example</label>
      <label><input v-model="policy.shop" type="checkbox" /> shop.example</label>
      <label><input v-model="policy.billing" type="checkbox" /> billing.example</label>
    </div>
    <div class="row3">
      <label class="field"><span>Risk up to</span>
        <select v-model="policy.risk"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select>
      </label>
      <label class="field"><span>Per action, USD</span><input v-model="policy.each" inputmode="decimal" /></label>
      <label class="field"><span>Total, USD</span><input v-model="policy.total" inputmode="decimal" /></label>
    </div>
    <label class="field"><span>Expires in</span>
      <select v-model="policy.exp"><option value="15m">15 minutes</option><option value="8h">8 hours</option><option value="7d">7 days</option></select>
    </label>
    <div class="grant">
      <code :title="grant">{{ short }}</code>
      <pre>{{ caveats }}</pre>
    </div>
  </details>
</template>

<style scoped src="./controls.css"></style>
<style scoped>
.policy { border-top: 1px solid var(--vp-c-divider); padding-top: 12px; margin-top: 4px; }
.policy summary { font-family: var(--font-head); font-weight: 600; cursor: pointer; margin-bottom: 8px; }
.policy > * + * { margin-top: 10px; }
.checks { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 0.85rem; color: var(--vp-c-text-2); }
.checks input { accent-color: var(--amber); }
.row3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.grant code { font-size: 0.72rem; color: var(--vp-c-text-3); word-break: break-all; }
.grant pre { margin: 6px 0 0; font-family: var(--vp-font-family-mono); font-size: 0.74rem; line-height: 1.6; color: var(--vp-c-text-2); background: var(--vp-c-bg-soft); padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }

@media (max-width: 640px) {
  .row3 { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 640px), (pointer: coarse) {
  .policy summary { min-height: 44px; padding: 10px 0; margin-bottom: 0; }
  .checks label { min-height: 44px; display: inline-flex; align-items: center; gap: 4px; }
}
</style>
