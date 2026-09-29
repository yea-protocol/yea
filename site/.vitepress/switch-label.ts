/**
 * VitePress server-renders its appearance switch (`role=switch`) with an empty title and names it
 * only on the client. This gives the static HTML a name too, so the switch isn't an unnamed
 * control before hydration or without JavaScript. It throws if a page has the switch but the markup
 * no longer matches, so a VitePress update can't turn it into a silent no-op.
 */

/** The switch as VitePress 1.6 renders it, and with its name. */
const SWITCH =
  'class="VPSwitch VPSwitchAppearance" type="button" role="switch" title ';
const NAMED =
  'class="VPSwitch VPSwitchAppearance" type="button" role="switch" aria-label="Dark theme" title ';

export function labelAppearanceSwitch(html: string, page = 'a page'): string {
  const out = html.replaceAll(SWITCH, NAMED);

  if (
    out.includes('VPSwitchAppearance') &&
    !out.includes('aria-label="Dark theme"')
  ) {
    throw new Error(
      `labelAppearanceSwitch: ${page} has the appearance switch, but its markup changed`,
    );
  }

  return out;
}
