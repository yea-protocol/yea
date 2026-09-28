/**
 * Keeps the theme-color meta in step with the appearance toggle, so the browser chrome matches
 * the page in light and dark.
 */
import { inBrowser, useData } from 'vitepress';
import { watch } from 'vue';
import { THEME_COLORS } from '../head';

export function useThemeColor(): void {
  const { isDark } = useData();

  watch(
    isDark,
    (dark) => {
      if (!inBrowser) {
        return;
      }

      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute(
          'content',
          dark ? THEME_COLORS.dark : THEME_COLORS.light,
        );
    },
    { immediate: true },
  );
}
