<script setup lang="ts">
/**
 * The landing page: the visitor approves a real proposal, then the protocol state by state,
 * the evidence, a real model's words, the comparison and where to go next.
 * This file lays the sections out; they live in landing/.
 */
import ClosingSection from './landing/ClosingSection.vue';
import CompareSection from './landing/CompareSection.vue';
import EvidenceSection from './landing/EvidenceSection.vue';
import HeroSection from './landing/HeroSection.vue';
import PathsSection from './landing/PathsSection.vue';
import QuoteSection from './landing/QuoteSection.vue';
import StatesSection from './landing/StatesSection.vue';
</script>

<template>
  <main class="landing">
    <HeroSection />
    <PathsSection />
    <StatesSection />
    <EvidenceSection />
    <QuoteSection />
    <CompareSection />
    <ClosingSection />
  </main>
</template>

<style src="./landing/landing.css"></style>
