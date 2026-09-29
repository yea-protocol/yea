/**
 * The YEA theme: VitePress's default theme without its bundled Inter, Public Sans for all
 * human-facing text and JetBrains Mono for machine output (both from @fontsource), the brand
 * layer in style.css, the landing and playground components, and a layout that keeps the
 * theme-color meta in step with the appearance toggle.
 */
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme-without-fonts';
import { defineAsyncComponent, defineComponent, h } from 'vue';
import '@fontsource-variable/public-sans';
import '@fontsource-variable/public-sans/wght-italic.css';
import '@fontsource-variable/jetbrains-mono';
import './style.css';
import Playground from './components/Playground.vue';
import { useThemeColor } from './theme-color';

/** VitePress's layout, plus the theme-color sync. */
const Layout = defineComponent({
  setup() {
    useThemeColor();

    return () => h(DefaultTheme.Layout);
  },
});

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    // Only the home page uses the landing: load it (and its recorded exchange) there alone.
    app.component(
      'Landing',
      defineAsyncComponent(() => import('./components/Landing.vue')),
    );
    app.component('Playground', Playground);
  },
} satisfies Theme;
