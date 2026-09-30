/**
 * Where the hero's parts sit in its layout, found by data attributes rather than style classes:
 * the thread (data-thread), each message's junction dot (data-junction), the slip (data-slip)
 * and its perforation (data-approval), whose left end is the approval point. Measured by layout
 * offsets, so the slip's arrival transform doesn't move them.
 */
import type { Point } from './junction';

/** An element's box in `root`'s layout (root must be one of its offset parents). */
export function layoutBox(el: HTMLElement, root: HTMLElement) {
  let x = 0;
  let y = 0;

  for (
    let n: Element | null = el;
    n instanceof HTMLElement && n !== root;
    n = n.offsetParent
  ) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }

  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/** The approval point: the slip's left edge at its perforation, in `root`'s layout. */
export function approvalPoint(root: HTMLElement): Point | null {
  const slip = root.querySelector<HTMLElement>('[data-slip]');
  const stub = root.querySelector<HTMLElement>('[data-approval]');

  return slip && stub
    ? { x: layoutBox(slip, root).x, y: layoutBox(stub, root).y }
    : null;
}
