/**
 * VitePress server-renders its appearance switch (`role=switch`) with an empty title and names it
 * only on the client. This gives the static HTML a name too, so the switch isn't an unnamed
 * control before hydration or without JavaScript. It throws if any switch on a page no longer
 * matches, so a VitePress update can't turn it into a silent no-op.
 */

/** The switch as VitePress 1.6 renders it, and with its name. */
const SWITCH =
  'class="VPSwitch VPSwitchAppearance" type="button" role="switch" title ';
const NAMED =
  'class="VPSwitch VPSwitchAppearance" type="button" role="switch" aria-label="Dark theme" title ';

export function labelAppearanceSwitch(html: string, page = 'a page'): string {
  const out = html.replaceAll(SWITCH, NAMED);
  const switches = out.split('VPSwitchAppearance').length - 1;
  const named = out.split(NAMED).length - 1;

  if (named !== switches) {
    throw new Error(
      `labelAppearanceSwitch: ${page} has an appearance switch whose markup changed`,
    );
  }

  return out;
}
