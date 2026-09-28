/**
 * The playground's keyboard shortcuts and how to name them per platform: whether the page
 * runs on an Apple platform; the send shortcut (⌘↵ or Ctrl+↵, either works everywhere),
 * how to match it, and how to name it on the button and in `aria-keyshortcuts`; and the copy
 * keys the clipboard fallback asks for.
 */

/** Whether the page runs on macOS or iOS. False on the server. */
export function isApple(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** The hint shown on the Send button. */
export const sendHint = (apple: boolean) => (apple ? '⌘↵' : 'Ctrl+↵');

/** The keys to press to copy, as the copy fallback names them. */
export const copyKeys = (apple: boolean) => (apple ? '⌘C' : 'Ctrl+C');

/** Both send shortcuts as `aria-keyshortcuts` names them, this platform's first. */
export const sendKeys = (apple: boolean) =>
  apple ? 'Meta+Enter Control+Enter' : 'Control+Enter Meta+Enter';

/** Whether a key press is the send shortcut. */
export const isSendShortcut = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && e.key === 'Enter';
