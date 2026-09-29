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
  state-amber-light: "#8E5400"
  consent-amber-soft: "#FFB2242E"
  consent-amber-soft-dark: "#FFB2241A"
  ink-lifted: "#385281"
  ink-lifted-hover: "#2C4167"
  ink-lifted-dark: "#A3B8DF"
  ink-lifted-dark-hover: "#BFD0EC"
  receipt-green: "#2BD9A5"
  state-green-light: "#0B6E52"
  refusal-red: "#FF5C5C"
  state-red-light: "#B52F2F"
typography:
  display:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "clamp(2.25rem, 1.75rem + 1.6vw, 3.125rem)"
    fontWeight: 650
    lineHeight: 1.06
    letterSpacing: "-0.026em"
  headline:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "clamp(1.75rem, 1.3rem + 1.6vw, 2.5rem)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.022em"
  doc-title:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "2.4rem"
    fontWeight: 750
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.012em"
  path-heading:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 1.2rem + 1vw, 1.9rem)"
    fontWeight: 700
    lineHeight: 1.15
  quote:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 1.1rem + 1.6vw, 2.25rem)"
    fontWeight: 600
    lineHeight: 1.28
  slip-summary:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "clamp(1.3rem, 1.1rem + 0.8vw, 1.6rem)"
    fontWeight: 700
    lineHeight: 1.2
  subsection:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.75
  landing-body:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.65
  small:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
  lede:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.4
  label-large:
    fontFamily: "Public Sans Variable, Public Sans Fallback, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
  lens:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.7
  lens-phone:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.7
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
    backgroundColor: "{colors.ink-text}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 20px"
  button-consent:
    backgroundColor: "{colors.signal-amber}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 20px"
  button-consent-hover:
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
  lens-block:
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
    backgroundColor: "{colors.consent-amber-soft}"
    textColor: "{colors.paper-text-2}"
    rounded: "{rounded.lg}"
    padding: "16px 18px"
---

# Design System: YEA docs site

This file documents the site **as it is today** (late September 2026): the VitePress default theme with
a brand layer in `site/.vitepress/theme/style.css`, plus two custom components, `Landing.vue` and
`Playground.vue`. The frontmatter lists both themes' values; Colors says which is which. The protocol's design decisions live in `docs/design.md`, which is
a different document.

## 1. Overview

**Creative North Star: "Ink, Paper, Signal"**

The system is two surfaces and one signal. Ink (#0B0D12, a blue-black) and paper (#F7F5F0, a warm
off-white) are the grounds. The site follows the reader's OS theme (`appearance: true`) and is
designed and reviewed light first; both themes meet WCAG AA. Amber is the signal, and it means one
thing: a proposal waiting on a person's consent. Green is a receipt, red is a refusal. The logo carries the
same idea: a stroke-drawn Y (the "Junction" mark) where two strokes meet at an amber approval
point and one action continues.

Everything else is stock VitePress: the top nav, sidebar, local search, outline, prev/next
footer, custom containers and Shiki code blocks (a paper-tuned github-light, built in
`site/.vitepress/shiki-light.ts`, and `github-dark-dimmed`). Brand presence comes from the
palette, Public Sans set heavy for headings, the landing's proposal slip, and the mono Lens that
fills the landing's protocol states and the playground's output pane. Density is moderate on docs
pages (VitePress defaults) and on the landing, which runs hero, two paths, five protocol states,
one evidence chart, a quote, the comparison table and a closing band.

Layout is a centred column: 1180px on the landing, 1360px on the playground, VitePress's doc
width (688px content) on guide pages. Landing bands are separated by 1px hairline rules, with
fluid padding (`clamp(64px, 8vw, 112px)`) that varies by section.

Motion: only state changes move. On the landing, the slip's border changes colour over 300ms and
buttons change over 150ms, both `cubic-bezier(0.25, 1, 0.5, 1)`; there is no entrance
choreography and no replay. VitePress's own chrome changes over 250ms.
`prefers-reduced-motion` cuts every CSS animation and transition to 0.01ms in `style.css`.

**Decided direction (James, 2026-09-28), all built in #117:**
- **Type:** Public Sans (variable, via `@fontsource`) is the one family for all human-facing
  text, with hierarchy carried by weight; JetBrains Mono for Lens and other machine output.
- **Theme:** follow the OS (`appearance: true`), designed and reviewed light first; both themes
  meet WCAG AA.
- **Colour:** a separate link token (Ink, Lifted), so amber means only proposed and waiting on
  consent; inline code and containers are neutral. Its hue was proposed in #171 and its chroma
  lowered in review, not chosen by James.
- **Landing:** a proposal-slip hero in which the visitor approves a real proposal, sees the
  receipt and undoes it, running the real core; sections ordered by protocol state; one
  evidence chart with its caveats beside it; two paths, "I have an MCP server" and "I'm
  building an agent or service". See the Proposal Slip component.

This system rejects, per PRODUCT.md: generic AI-agent startup marketing, crypto and web3
aesthetics, security fear-marketing, SaaS landing templates, decorative terminal costume, and
overclaiming numbers.

**Key Characteristics:**
- Follows the OS, light first; warm paper for light, not white.
- One signal colour whose meaning is protocol state; interaction is a separate ink-blue.
- One type family, with hierarchy by weight and scale.
- Real Lens output as the main image, set in mono.
- Flat surfaces separated by hairlines; almost no shadow.
- Stock VitePress navigation and doc layout.

## 2. Colors

A near-monochrome ink-and-paper palette, three state colours used only for protocol state, and one
interaction colour.

### Primary
- **Signal Amber** (signal-amber; light-theme text state-amber-light): the brand hue and the
  "proposed / waiting on consent" state. Lens proposal lines, `consent_required`, the consent card
  (1px amber border on `--state-amber-soft`) and its Approve button (full amber fill with ink
  text, which reads in both themes). Also the approval point in the logo.
- **Ink, Lifted** (ink-lifted, ink-lifted-dark; `--vp-c-brand-*`): docs links, focus rings, the
  active nav and sidebar item, playground form accents. It is the ink hue (about 262 in OKLCH) at
  low chroma, lifted just enough to read as a link, so it belongs to the ink family rather than
  competing with the states.

### Secondary
- **Receipt Green** (receipt-green; light theme state-green-light): committed, a receipt exists.
  Lens lines starting with `✓`, the `RECEIPT` badge, history dots.

### Tertiary
- **Refusal Red** (refusal-red; light theme state-red-light): refused or failed. Errors other than
  `consent_required`, invalid params, the playground's fatal message.

### Neutral
- **Ink** (ink): dark page background and the light theme's primary button and text. Inline code
  is neutral text on the code tint.
- **Raised Ink** (ink-raised) and **Soft Ink** (ink-soft): dark elevated panels (`--vp-c-bg-elv`)
  and the segmented-control track (`--vp-c-bg-soft`).
- **Code Ink** (ink-code): dark code blocks and the landing's Lens blocks.
- **Ink Divider / Ink Border** (ink-divider, ink-border): hairlines and control outlines in dark.
- **Bone Text** (ink-text) and **Fog Text** (ink-text-2): dark primary and secondary text.
- **Slate Muted** (slate-muted): tertiary text in dark: captions, table headers, wire lines.
- **Paper** (paper), **Paper 2** (paper-2), **Paper Soft** (paper-soft), **Paper Code**
  (paper-code): light backgrounds, from page to sidebar to soft fills to code blocks.
- **Paper Divider / Paper Border** (paper-divider, paper-border): light hairlines and outlines.
- **Graphite** (paper-text-2) and **Pewter** (paper-text-3): light secondary and tertiary text.

### Named Rules
**The State Colour Rule.** Amber is proposed and waiting on a person, green is committed, red is
refused. Nothing else gets those colours (stated in the header of `style.css`). Primary buttons
are neutral (ink on paper, bone on ink). Containers are neutral: tips and info use a soft fill,
and VitePress's `warning` containers (yellow by default) use the soft fill with a full 1px
border in tertiary text; inline code in any container stays neutral. A warning is a caution to
the reader, not a protocol state. `danger` containers are neutral too, with the strongest
border (1px in primary text), because red means refused. Doc blockquotes are a box with a 1px
divider border and secondary text, with no side stripe. A page's source note (the spec page) is one quiet line
(`.page-source`), not a callout.

**The Lens Block Rule.** Lens shown in the docs is coloured the same way everywhere: in code
fences marked `text`, `txt`, `lens` or nothing, each line gets its state class from the shared
`components/lens-lines.ts` (through the Shiki transformer in `site/.vitepress/lens-fence.ts`):
amber for proposals and consent requests, green for receipts, red for refusals, secondary text for
effects, tertiary for wire lines (`→`) and handles. A `✗` line that asks for approval
(`consent_required`, "approval needed") is amber, not red. To show output that looks like Lens
but isn't, mark the fence `plaintext`, or add `no-lens` after the language (```` ```text no-lens ````),
as the README's Petstore listing does.

**The Consent Button Rule.** Every Approve that signs a proposal is amber: full amber fill with
ink text (10.8:1 in both themes), hover a lighter amber. That is the playground's "Approve as
human and commit" and the landing slip's Approve. No other button is amber.

**The Two Link Rule.** Links are underlined everywhere; colour alone never marks a link. On
product surfaces (guides, reference, spec, playground) links are Ink, Lifted, because readers
scan dense pages for them and the nav needs an active colour. On the brand surface (the
landing) links are ink with a tertiary-text underline, because there colour means protocol state
and the slip carries it; a fourth hue beside the slip would compete with it.

**The No Pure Extremes Rule.** No `#fff` or `#000`: the lightest surface is #FCFBF8 (raised
panels), the darkest press state #05060A, and the dark primary button hovers to paper.

**The Light Theme Is Equal Rule.** Every state colour has a light-theme partner darkened for
contrast on paper. Light-theme text colours clear 4.5:1 on paper, on the code tint (#ECE8DF, also
used for inline code) and on the container tints. Four of Shiki's github-light token colours are
darkened, in a modified theme object, for the same reason. In dark, the consent tint is 10%
amber so tertiary text on it still clears 4.5:1.

## 3. Typography

**Display and Body Font:** Public Sans Variable, roman and italic (with system-ui)
**Label/Mono Font:** JetBrains Mono Variable (with ui-monospace)

**Character:** One plain, institutional sans for everything a person reads, with hierarchy made by
weight and scale, and a coding mono for everything the protocol emits. Both are self-hosted
through `@fontsource`. `site/.vitepress/head.ts` preloads the Latin Public Sans file on every page
and the Latin JetBrains Mono file on the home page (its hero shows Lens above the fold). Until
Public Sans arrives, "Public Sans Fallback" (local Arial with size-adjust 105.6%, ascent 89.96%,
descent 21.31%, measured against Public Sans at 400) holds the same line lengths and heights, so
the swap barely moves the page.

### Landing hierarchy (one family)
- **Display** (650, clamp 2.25–3.125rem, 1.06, -0.026em, one sentence per line): the landing headline only, a step below the slip so it doesn't compete with it.
- **Headline** (700, clamp 1.75–2.5rem, 1.1, -0.022em): section headings; the paths use
  clamp 1.5–1.9rem, and the pull quote 600 at clamp 1.5–2.25rem.
- **Title** (650, 1.375rem, 1.25): the protocol-state step titles; the slip's summary is 700 at
  clamp 1.3–1.6rem.
- **Body** (400, 1.0625rem, 1.65; 1rem under 640px), capped at 62ch. The lede is 1.1875rem.
- **Small** (400, 0.9375rem, 1.6): notes and asides beside the slip and chart, chart rows, the
  comparison table and the paths' links.
- **Label** (600, 0.8125–0.875rem): the slip's facts, chart headers, table headers.
- **Lens** (400, 0.8125rem, 1.7; 0.75rem under 640px): recorded exchange output, effects, the
  hash. Chart values stay in the body font with tabular numbers.

### Docs and playground hierarchy (the weight ladder: 750 / 700 / 600 / 400)
- **Doc Title** (750, 2.4rem, 1.1, -0.025em): `h1` on guide and reference pages; the playground
  title is 750 at 2rem, and the nav title 750.
- **Section** (700, 1.625rem, 1.25, -0.015em): doc `h2`.
- **Subsection** (600, 1.25rem, 1.35): doc `h3`; `h4` is 600 at 1.0625rem.
- Heading levels never skip: a markdown rule (`site/.vitepress/markdown-rules.ts`) lifts a
  heading that jumps more than one level, as included README sections do.
- **Body** (400, 16px, 1.75): VitePress doc prose, capped at 72ch for `p` and `li`.
- **Label** (600, 0.82rem): playground form labels, segmented controls.
- **Lens** (400, 13px, 1.75; 12px under 640px): playground output, frames.

### Named Rules
**The Machine Voice Rule.** Mono is reserved for what machines say or read: Lens, frames, verbs,
ids, commands. Human-facing copy is never set in mono.

## 4. Elevation

Flat. Depth comes from tonal steps (ink to raised ink, paper to paper soft) and 1px hairline
borders, not shadow. The only shadow in the site is the segmented control's selected state, a
1px ring (`box-shadow: 0 0 0 1px var(--vp-c-divider)`) that reads as a border. The social preview
(`docs/brand/social.html`, rendered to `social.png`) follows the same system: ink on paper, the
proposal slip in a 1.5px amber-ink border, Public Sans and JetBrains Mono, no shadow.

### Named Rules
**The Hairline Rule.** Separate with a 1px divider or a tonal step. Never stack a border, a fill
and a shadow on the same surface.

## 5. Components

### Buttons
- **Shape:** gently rounded (8px), 44px tall, 20px side padding, weight 600 at 0.95rem.
- **Primary:** neutral: ink on paper in light, bone on ink in dark. Amber is kept for consent.
- **Consent:** every Approve that signs a proposal (the playground's "Approve as human and
  commit", the landing slip's Approve): full amber with ink text. See the Consent Button Rule.
- **Secondary:** transparent with a 1px border; the border darkens to tertiary text on hover.
- **Ghost:** no border (the GitHub link).
- **Hover / Focus:** 150ms background and border transitions. Focus is the global
  `:focus-visible` 2px Ink, Lifted outline with 2px offset.

### Chips
- **Preset chips** (playground scenarios, quick actions such as "Commit p_…", "Undo r_…"): pill
  (999px), 1px border, page background, 0.84rem. Hover turns the border Ink, Lifted.

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
  (Why YEA, Guide, Playground, Spec), appearance switch, GitHub icon. Active item is Ink, Lifted.
  Sidebar groups: Start, Concepts, Build, Reference. Mobile collapses to a hamburger and a
  "Menu / On this page" bar.

### Proposal Slip (signature component)
The landing hero's right column (`landing/ProposalSlip.vue`, `SlipStub.vue`, `use-slip.ts`): a
real proposal from the example shop, over the example policy's $40 limit, as a permission slip.
- **Top half:** what the service proposes. The proposal id and service, a state chip, the
  summary, the effects in mono, three facts (uses, risk, undo window) and the service's reason
  for asking.
- **Tear-off stub:** below a dashed perforation with a notch cut into each edge. It holds what the
  person signs: the proposal's hash, one Approve button and a line saying exactly what is signed.
- **States.** The border and chip follow protocol state:
  - neutral "Recorded" until the core is live;
  - amber "Waiting on you";
  - green "✓ Committed", where the stub shows the receipt, its undo window and Undo;
  - neutral "↶ Undone";
  - neutral "Expired" when the proposal, undo window or example policy runs out;
  - red for a failed step.

  Once live, Start again is always offered.
- **Recording and live core.** The page paints from a recording of the same exchange
  (`landing/exchange.ts`, generated from the core), so it needs no JavaScript to render; a
  `<noscript>` line says approving needs it. The core loads when the browser is idle.
- **Keyboard.** Focus moves to the next button after each step, and one live line announces
  what happened.

### Playground (signature component)
A two-pane tool: the agent's request on the left (service and verb segmented controls, capability
select, JSON params, auto toggle, token budget, the person's policy, a live-signed grant), and
what the model reads on the right (state badge, token counts, Lens / Frames tabs, quick actions,
the consent card, and a history list with state dots).

### Consent Card
The approval moment: amber 1px border on an amber-tinted fill, 12px radius, a heading ("Your
agent needs your approval"), the proposal summary, its effects in mono, the uses/risk/undo line,
one amber consent button ("Approve as human and commit") and a fine-print line saying exactly what is
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
  use a tinted block with a full 1px border, as the warning containers do (a neutral soft fill:
  a caution is not a protocol state, so it isn't amber).
- **Don't** set human-facing copy in mono, or machine output in the body font.
- **Don't** mention how "YEA" is pronounced, and don't use Calendly as an example.
