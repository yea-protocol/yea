/**
 * The send shortcut: ⌘↵ on Apple platforms, Ctrl+↵ elsewhere (either one works everywhere),
 * and how to name it for the button hint and `aria-keyshortcuts`.
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

/** The shortcut as `aria-keyshortcuts` names it. */
export const sendKeys = (apple: boolean) =>
  apple ? 'Meta+Enter' : 'Control+Enter';

/** Whether a key press is the send shortcut. */
export const isSendShortcut = (e: KeyboardEvent) =>
  (e.metaKey || e.ctrlKey) && e.key === 'Enter';
