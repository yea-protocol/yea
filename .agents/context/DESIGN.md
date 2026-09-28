---
name: YEA docs site
description: The open protocol for AI agents acting on behalf of people, documented on VitePress.
colors:
  ink: "#0B0D12"
  ink-raised: "#12151C"
  ink-soft: "#1A1E27"
  ink-deep: "#090B0F"
  ink-code: "#10131A"
  ink-divider: "#232834"
  ink-border: "#2C3240"
  ink-text: "#ECEAE4"
  ink-text-2: "#B4B8BF"
  slate-muted: "#8A8F98"
  paper: "#F7F5F0"
  paper-2: "#EFECE4"
  paper-soft: "#E9E5DB"
  paper-code: "#ECE8DF"
  paper-divider: "#DAD5C9"
  paper-border: "#CFC9BB"
  paper-text-2: "#3C414B"
  paper-text-3: "#5C616A"
  signal-amber: "#FFB224"
  signal-amber-hover: "#FFC04D"
  signal-amber-press: "#E09A10"
  amber-ink: "#8E5400"
  amber-ink-hover: "#9A5B00"
  state-amber-light: "#8E5400"
  receipt-green: "#2BD9A5"
  state-green-light: "#0B6E52"
  refusal-red: "#FF5C5C"
  state-red-light: "#B52F2F"
typography:
  display:
    fontFamily: "Space Grotesk Variable, Space Grotesk, system-ui, sans-serif"
    fontSize: "clamp(2.3rem, 4.4vw, 3.6rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Space Grotesk Variable, Space Grotesk, system-ui, sans-serif"
    fontSize: "clamp(1.6rem, 2.6vw, 2.1rem)"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  doc-title:
    fontFamily: "Space Grotesk Variable, Space Grotesk, system-ui, sans-serif"
    fontSize: "2.4rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Space Grotesk Variable, Space Grotesk, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.75
  lede:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "1.12rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 600
    lineHeight: 1.4
  lens:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.75
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "56px"
  4xl: "72px"
  5xl: "96px"
components:
  button-primary-dark:
    backgroundColor: "{colors.signal-amber}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 20px"
  button-primary-dark-hover:
    backgroundColor: "{colors.signal-amber-hover}"
  button-primary-light:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 20px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-text}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 20px"
  preset-chip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-text}"
    rounded: "{rounded.pill}"
    padding: "7px 12px"
  segmented-control:
    backgroundColor: "{colors.ink-soft}"
    textColor: "{colors.ink-text-2}"
    rounded: "{rounded.md}"
    padding: "4px"
  input-field:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-text}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  exchange-panel:
    backgroundColor: "{colors.ink-code}"
    textColor: "{colors.ink-text-2}"
    typography: "{typography.lens}"
    rounded: "{rounded.xl}"
  state-badge:
    backgroundColor: "transparent"
    textColor: "{colors.receipt-green}"
    rounded: "{rounded.sm}"
    padding: "3px 9px"
  consent-card:
    backgroundColor: "{colors.ink-raised}"
    textColor: "{colors.ink-text-2}"
    rounded: "{rounded.lg}"
    padding: "16px 18px"
---

# Design System: YEA docs site

This file documents the site **as it is today** (September 2026): the VitePress default theme with
a brand layer in `site/.vitepress/theme/style.css`, plus two custom components, `Landing.vue` and
`Playground.vue`. Hex values for the dark theme are the frontmatter tokens; the light theme swaps
them as described under Colors. The protocol's design decisions live in `docs/design.md`, which is
a different document.

## 1. Overview

**Creative North Star: "Ink, Paper, Signal"**

The system is two surfaces and one signal. Ink (#0B0D12, a blue-black) and paper (#F7F5F0, a warm
off-white) are the grounds; the dark theme is the default (`appearance: 'dark'` in the VitePress
config), with a light theme one toggle away. Amber is the signal, and it is supposed to mean one
thing: a proposal waiting on a person. Green is a receipt, red is a refusal. The logo carries the
same idea: a stroke-drawn Y (the "Junction" mark) where two strokes meet at an amber approval
point and one action continues.

Everything else is stock VitePress: the top nav, sidebar, local search, outline, prev/next
footer, custom containers and Shiki code blocks (`github-light` / `github-dark-dimmed`). Brand
presence comes from the palette, Space Grotesk headings, and the mono Lens exchange that anchors
the landing hero and the playground's output pane. Density is moderate on docs pages (VitePress
defaults) and high on the landing, which stacks seven full-width bands, three of them tables.

Layout is a centred column: 1152px on the landing, 1360px on the playground, VitePress's doc
width (688px content) on guide pages. Sections are separated by 1px hairline rules and a uniform
72px band padding.

Motion today: the hero exchange reveals its four steps at 400ms and then every 1.5s, each step
fading in over 450ms with a 4px rise (`ease-out`), and the undone commit greys out over 400ms. The
stepper's colour changes over 300ms, landing buttons over 150ms, and VitePress's own chrome over
250ms. With JavaScript on, the page renders the finished exchange, then blanks and replays it.
`prefers-reduced-motion` skips the replay in JavaScript and cuts every CSS animation and
transition to 0.01ms in `style.css`.

**Decided direction (James, 2026-09-28; not built yet).** These replace the current values as the
theme and landing PRs in #117 land; update this file with each one.
- **Type:** Public Sans (variable, via `@fontsource`) is the one family for all human-facing
  text, with hierarchy carried by strong weight contrast; JetBrains Mono stays for Lens and other
  machine output. Space Grotesk and Inter go.
- **Theme:** follow the OS (`appearance: true`), designed and reviewed light first; both themes
  meet WCAG AA.
- **Colour:** a separate link/brand token, so amber means only proposed and waiting on consent;
  inline code turns neutral.
- **Landing:** a proposal-slip hero in which the visitor approves a real proposal, sees the
  receipt and undoes it, running the real core; sections ordered by protocol state; one
  evidence chart with its caveats beside it; two paths, "I have an MCP server" (with the
  framework card from #75) and "I'm building an agent or service".

This system rejects, per PRODUCT.md: generic AI-agent startup marketing, crypto and web3
aesthetics, security fear-marketing, SaaS landing templates, decorative terminal costume, and
overclaiming numbers.

**Key Characteristics:**
- Dark by default today (light-first, OS-following is decided); warm paper for light, not white.
- One signal colour whose meaning is protocol state.
- Real Lens output as the main image, set in mono.
- Flat surfaces separated by hairlines; almost no shadow.
- Stock VitePress navigation and doc layout.

## 2. Colors

A near-monochrome ink-and-paper palette with three state colours that are meant to be used only
for protocol state.

### Primary
- **Signal Amber** (signal-amber): the brand hue and the "proposed / waiting on a person" state.
  In the dark theme it is also `--vp-c-brand-1`, so it colours links, the active nav item, inline
  code, the primary button, and the checkbox and range accents in the playground.
- **Amber Ink** (amber-ink): the light-theme `--vp-c-brand-1`. Amber is too light to read on
  paper, so the hue is darkened for links, active nav and inline code.

### Secondary
- **Receipt Green** (receipt-green; light theme state-green-light): committed, a receipt exists.
  Lens lines starting with `✓`, the `RECEIPT` badge, history dots.

### Tertiary
- **Refusal Red** (refusal-red; light theme state-red-light): refused or failed. Errors other than
  `consent_required`, invalid params, the playground's fatal message.

### Neutral
- **Ink** (ink): dark page background and the light theme's primary button and text.
- **Raised Ink** (ink-raised) and **Soft Ink** (ink-soft): dark elevated panels (`--vp-c-bg-elv`)
  and the segmented-control track (`--vp-c-bg-soft`).
- **Code Ink** (ink-code): dark code blocks and the hero exchange panel.
- **Ink Divider / Ink Border** (ink-divider, ink-border): hairlines and control outlines in dark.
- **Bone Text** (ink-text) and **Fog Text** (ink-text-2): dark primary and secondary text.
- **Slate Muted** (slate-muted): tertiary text in dark: captions, table headers, wire lines.
- **Paper** (paper), **Paper 2** (paper-2), **Paper Soft** (paper-soft), **Paper Code**
  (paper-code): light backgrounds, from page to sidebar to soft fills to code blocks.
- **Paper Divider / Paper Border** (paper-divider, paper-border): light hairlines and outlines.
- **Graphite** (paper-text-2) and **Pewter** (paper-text-3): light secondary and tertiary text.

### Named Rules
**The State Colour Rule.** Amber is proposed and waiting on a person, green is committed, red is
refused. Nothing else gets those colours (stated in the header of `style.css`). *Current
violations:* VitePress maps `--vp-c-brand-1` to amber, so every link, inline code chip, active
nav item and "current step" in the hero stepper is amber too, and doc blockquotes carry a 2px
amber left border (`.vp-doc blockquote` in `style.css`), which is also a side stripe. Fixing
these is the first theme task.

**The Light Theme Is Equal Rule.** Every state colour has a light-theme partner darkened for
contrast on paper. Light-theme text colours clear 4.5:1 on paper, on the code tint (#ECE8DF, also
used for inline code) and on the warning tint. Four of Shiki's github-light token colours are
darkened in light mode for the same reason.

## 3. Typography

**Display Font:** Space Grotesk Variable (with system-ui)
**Body Font:** Inter Variable (with system-ui)
**Label/Mono Font:** JetBrains Mono Variable (with ui-monospace)

**Character:** A quirky geometric grotesk for headings over a neutral workhorse sans, with a
coding mono for everything the protocol emits. All three are self-hosted through `@fontsource`.
Decided replacement: Public Sans for all human-facing text and JetBrains Mono for machine output
(see Overview).

### Hierarchy
- **Display** (600, clamp 2.3–3.6rem, 1.02): the landing headline only.
- **Headline** (600, clamp 1.6–2.1rem, 1.15): landing band headings; the pull quote uses Space
  Grotesk 500 at clamp 1.5–2.2rem.
- **Doc Title** (600, 2.4rem, 1.1): `h1` on guide and reference pages.
- **Title** (600, 1.25rem): landing sub-headings (`.minor`), consent card heading at 1.05rem.
- **Body** (400, 16px, 1.75): VitePress doc prose, capped at 72ch for `p` and `li`.
- **Lede** (400, 1.12rem, 1.6): the landing intro, capped at 46ch.
- **Label** (600, 0.82rem): form labels, stepper labels, segmented controls, table headers
  (0.84rem, tertiary colour).
- **Lens** (400, 12.5–13px, 1.75; 11.5px under 640px): the hero exchange, playground output,
  command blocks.

### Named Rules
**The Machine Voice Rule.** Mono is reserved for what machines say or read: Lens, frames, verbs,
ids, commands. Human-facing copy is never set in mono.

## 4. Elevation

Flat. Depth comes from tonal steps (ink to raised ink, paper to paper soft) and 1px hairline
borders, not shadow. The only shadow in the site is the segmented control's selected state, a
1px ring (`box-shadow: 0 0 0 1px var(--vp-c-divider)`) that reads as a border. The social preview
image (`docs/brand/social.html`) is the exception, with a large drop shadow and an amber radial
glow; it sits outside the site.

### Named Rules
**The Hairline Rule.** Separate with a 1px divider or a tonal step. Never stack a border, a fill
and a shadow on the same surface.

## 5. Components

### Buttons
- **Shape:** gently rounded (8px), 44px tall, 20px side padding, weight 600 at 0.95rem.
- **Primary:** amber on ink in the dark theme; ink on paper in the light theme (amber text on
  paper fails contrast, so the light primary button drops the brand hue entirely).
- **Secondary:** transparent with a 1px border; the border darkens to tertiary text on hover.
- **Ghost:** no border (the GitHub link).
- **Hover / Focus:** 150ms background and border transitions. Focus is the global
  `:focus-visible` 2px brand outline with 2px offset.

### Chips
- **Preset chips** (playground scenarios, quick actions such as "Commit p_…", "Undo r_…"): pill
  (999px), 1px border, page background, 0.84rem. Hover turns the border brand amber.

### Cards / Containers
- **Corner Style:** 12px for tables, command blocks and the consent card; 14px for the hero
  exchange and playground panes.
- **Background:** code ink / paper code for the exchange; raised ink / white for playground
  panes.
- **Shadow Strategy:** none (see Elevation).
- **Border:** 1px divider.
- **Internal Padding:** 18–20px.

### Inputs / Fields
- **Style:** page-background fill, 1px border, 8px radius, 8px × 10px padding, 0.88rem; params
  textarea in mono 0.8rem. Selects use a CSS-drawn chevron.
- **Focus:** the global 2px outline.
- **Error:** border turns refusal red, with a red message below; `aria-invalid` is set.

### Navigation
- Stock VitePress: logo (the mark only) and "YEA" title, local search with ⌘K, four text links
  (Why YEA, Guide, Playground, Spec), appearance switch, GitHub icon. Active item is brand amber.
  Sidebar groups: Start, Concepts, Build, Reference. Mobile collapses to a hamburger and a
  "Menu / On this page" bar.

### Hero Exchange (signature component)
The landing's right column: a four-step stepper (Intent, Proposal, Commit, Undo) over a mono
screen that reveals one real Lens exchange step by step (400ms, then every 1.5s), with a legend
(proposed, committed) and a Replay button. After undo, the commit lines are struck through and
greyed. The server-rendered page and reduced motion show the finished exchange; otherwise it
blanks and replays on load. To be replaced by the proposal-slip hero (see Overview).

### Playground (signature component)
A two-pane tool: the agent's request on the left (service and verb segmented controls, capability
select, JSON params, auto toggle, token budget, the person's policy, a live-signed grant), and
what the model reads on the right (state badge, token counts, Lens / Frames tabs, quick actions,
the consent card, and a history list with state dots).

### Consent Card
The approval moment: amber 1px border on an amber-tinted fill, 12px radius, a heading ("Your
agent needs your approval"), the proposal summary, its effects in mono, the uses/risk/undo line,
one primary button ("Approve as human and commit") and a fine-print line saying exactly what is
signed.

## 6. Do's and Don'ts

### Do:
- **Do** keep amber, green and red for protocol state: proposed, committed, refused.
- **Do** pair every state colour with a glyph or a word, as Lens does (`✓`, `✗`, `~`, `↶`).
- **Do** show real output: Lens a model would read, frames the core produced.
- **Do** put caveats next to numbers, at the same size as the claim, with the method linked.
- **Do** keep prose at 72ch or less and Lens at 12px or more.
- **Do** underline links in running text; colour alone doesn't mark a link.
- **Do** honour `prefers-reduced-motion` and render finished states without JavaScript.

### Don't:
- **Don't** use generic AI-agent startup marketing: purple-to-blue gradients, glowing orbs,
  robot or brain imagery.
- **Don't** use crypto and web3 aesthetics: neon on black, glitch effects.
- **Don't** use security fear-marketing: padlocks, shields, red alert banners.
- **Don't** use SaaS landing templates: hero-metric blocks, identical icon card grids, logo walls.
- **Don't** use decorative terminal costume: traffic-light window dots and glows as shorthand for
  "developer tool".
- **Don't** overclaim: no figure without a method link, no "10x".
- **Don't** imitate any other brand, including the MCP clients and APIs YEA works with.
- **Don't** use `border-left` or `border-right` wider than 1px as a coloured accent on callouts;
  use a tinted block with a full 1px border, as the landing's key warning does.
- **Don't** set human-facing copy in mono, or machine output in the body font.
- **Don't** mention how "YEA" is pronounced, and don't use Calendly as an example.
