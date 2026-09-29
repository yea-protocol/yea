/**
 * The YEA theme: VitePress's default theme without its bundled Inter (the variable Inter from
 * @fontsource is loaded here instead), the brand layer in style.css, and the landing and
 * playground components.
 */
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme-without-fonts';
import { defineAsyncComponent } from 'vue';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './style.css';
import Playground from './components/Playground.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // Only the home page uses the landing: load it (and its recorded exchange) there alone.
    app.component(
      'Landing',
      defineAsyncComponent(() => import('./components/Landing.vue')),
    );
    app.component('Playground', Playground);
  },
} satisfies Theme;
