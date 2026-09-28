/**
 * Copying text: through the Clipboard API, or, when that is missing or refused (an insecure
 * page, a denied permission), by selecting the text so the reader can copy it themselves.
 */

export type CopyResult = 'copied' | 'selected';

/** Select everything inside `el`. */
function selectContents(el: HTMLElement) {
  const range = document.createRange();
  const selection = window.getSelection();

  range.selectNodeContents(el);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Copy `text`; if the clipboard refuses, select `fallback` instead. */
export async function copyOrSelect(
  text: string,
  fallback: HTMLElement | null,
): Promise<CopyResult> {
  try {
    await navigator.clipboard.writeText(text);

    return 'copied';
  } catch {
    if (fallback) {
      selectContents(fallback);
    }

    return 'selected';
  }
}
