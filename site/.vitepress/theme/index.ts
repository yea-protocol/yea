/**
 * The docs site theme: VitePress's default theme plus the site's fonts,
 * styles, and the Landing and Playground components.
 */
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './style.css';
import Landing from './components/Landing.vue';
import Playground from './components/Playground.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Landing', Landing);
    app.component('Playground', Playground);
  },
} satisfies Theme;
