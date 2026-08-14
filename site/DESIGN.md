---
name: vidcut landing page
description: Director's storyboard mark-up world — the AI drafts in graphite, the human's red pencil has the last word.
colors:
  paper: '#ede8dc'
  paper-card: '#f7f3e9'
  ink: '#26231d'
  graphite: '#4a463c'
  graphite-faint: '#635c4b'
  red-pencil: '#c0392b'
  red-pencil-deep: '#a02a1e'
  highlighter: '#f3d13d'
  stamp-green: '#2a7a45'
  non-photo-blue: '#8fb0c9'
  washi-tape: 'rgba(214, 192, 122, .55)'
  code-slate: '#2b271d'
  code-paper: '#efe9d8'
  code-amber: '#e8b04c'
  code-comment: '#aca283'
typography:
  display:
    fontFamily: 'Jost, Helvetica Neue, sans-serif'
    fontSize: 'clamp(38px, 5.4vw, 74px)'
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: '-0.015em'
  headline:
    fontFamily: 'Jost, Helvetica Neue, sans-serif'
    fontSize: 'clamp(30px, 3.4vw, 46px)'
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: '-0.01em'
  body:
    fontFamily: 'Jost, Helvetica Neue, sans-serif'
    fontSize: '17px'
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: 'Jost, Helvetica Neue, sans-serif'
    fontSize: '12px'
    fontWeight: 600
    letterSpacing: '0.16em'
  annotation:
    fontFamily: 'Caveat, cursive'
    fontSize: '19px'
    fontWeight: 500
    lineHeight: 1.12
  mono:
    fontFamily: 'SF Mono, Menlo, Consolas, monospace'
    fontSize: '13px'
    fontWeight: 400
  karaoke-specimen:
    fontFamily: 'Jost, Helvetica Neue, sans-serif'
    fontSize: 'clamp(36px, 4.6vw, 58px)'
    fontWeight: 700
    letterSpacing: '0.02em'
rounded:
  hairline: '2px'
  chip: '3px'
  card: '4px'
  stamp: '5px'
spacing:
  gutter: 'clamp(24px, 5vw, 72px)'
  section: 'clamp(64px, 11vh, 130px)'
  frame-gap: 'clamp(18px, 2.6vw, 40px)'
  note-gap: '14px'
components:
  button-github:
    backgroundColor: '{colors.paper-card}'
    textColor: '{colors.ink}'
    rounded: '{rounded.chip}'
    padding: '7px 15px'
  button-github-hover:
    backgroundColor: '#ffffff'
    textColor: '{colors.ink}'
  cta-star:
    backgroundColor: 'transparent'
    textColor: '{colors.ink}'
    padding: '16px 30px'
  frame-card:
    backgroundColor: '{colors.paper-card}'
    rounded: '{rounded.card}'
  code-chip:
    backgroundColor: '{colors.paper-card}'
    textColor: '{colors.ink}'
    rounded: '{rounded.chip}'
    padding: '3px 8px'
  code-block:
    backgroundColor: '{colors.code-slate}'
    textColor: '{colors.code-paper}'
    rounded: '{rounded.card}'
    padding: '14px 18px'
  stamp-approved:
    backgroundColor: 'transparent'
    textColor: '{colors.stamp-green}'
    rounded: '{rounded.stamp}'
    padding: '4px 9px 2px'
---

# Design System: vidcut Landing Page

> **Scope.** This system governs only the static landing page under `site/`. The vidcut editor UI has its own incumbent system (`ui/src/theme.css`, a dark violet editor world) which this file does not describe and must not be merged with.
>
> **Sanctioned exception — the embassy (user-approved 2026-08-14).** The editor's **Agent Presence** elements — and only those — carry this paper world into the dark editor: a taped paper strip in the header and an index card in the Inspector, per `docs/superpowers/specs/2026-08-14-agent-presence-design.md`. Rationale: the AI _is_ this page's storyboard annotator, and its presence in the editor is the one piece of paper in the dark room. The exception is bounded: those two objects, these tokens and rules, no further spread.

## Overview

**Creative North Star: "The Director's Storyboard"**

The page is one real edit session drafted on paper: the AI's work appears as graphite pencil sketches on dot-grid drafting paper, and the human's authority appears as red-pencil mark-up over them. Every surface is a physical desk object — taped-down frames, approval stamps, washi tape, a hand-drawn playhead — and the whole hero is literally a timeline the visitor can scrub. The world deliberately refuses the AI-tool category defaults: no dark hero, no glow, no floating screenshot chrome, no feature-card grid.

Density is editorial and generous — one column of desk objects with wide gutters — but the objects themselves are busy with hand detail: sketch strokes displaced by a paper-tooth SVG turbulence filter, small rotations everywhere, dashed rules, dotted leaders. Warmth comes from the paper; authority comes from the red pencil; trust comes from technical margins in non-photo blue and mono timecode.

**Key Characteristics:**

- Warm dot-grid paper ground (#ede8dc) with brighter paper cards (#f7f3e9) laid on top
- Graphite sketch illustration: SVG strokes through the `#pencil` fractal-noise displacement filter, never crisp vectors
- Red pencil (#c0392b) as the annotation layer: Caveat handwriting, underlines, arrows, circled CTAs, the playhead, focus rings
- Nothing sits perfectly straight — tape, stamps, notes, code blocks all carry a small rotation
- One signature interaction: a single playhead scrubs the entire storyboard (sketch reveal, karaoke highlight, stamp landing); reduced motion gets the finished state

## Colors

A warm paper-and-pencil palette: two paper tones, three graphite inks, one dominant red accent, and three supporting desk pigments used only in their diegetic roles.

### Primary

- **Red Pencil** (#c0392b): the mark-up voice. Handwritten annotations, the H1 underline stroke, red keywords inside headlines (`<span class="red">`), sketch arrows between frames, the scrub playhead, circled CTA rings, link hover, and the dashed focus-visible outline. It is drawn (strokes, handwriting), almost never a fill.
- **Red Pencil Deep** (#a02a1e): pressed-harder red — karaoke-highlighted words and screenshot callout text.

### Secondary

- **Highlighter Yellow** (#f3d13d): marker swipe behind the currently-sung karaoke word, and text `::selection`. Always a background behind ink text, never a text color.
- **Stamp Green** (#2a7a45): approval only. Bordered, rotated, `mix-blend-mode: multiply` rubber stamps ("OK / APPROVED", "HUMAN OK / REQUIRED"). Appears nowhere else.

### Tertiary

- **Non-Photo Blue** (#8fb0c9): technical margins inside sketches — waveform squiggles, dimension lines, download arrows. Sketch-stroke only.
- **Washi Tape** (rgba(214, 192, 122, .55)): translucent tape strips fastening frames, screenshots, code blocks, and the shot-list card. Always slightly rotated, with a 1px ink-tinted drop shadow.

### Neutral

- **Paper** (#ede8dc): the page ground, always carrying the 24px dot-grid (`radial-gradient(rgba(38,35,29,.075) 1px, transparent 1.2px)`) plus a soft top-light radial.
- **Paper Card** (#f7f3e9): every raised object — storyboard frames, code chips, the shot-list card, step number circles, callout cards.
- **Ink** (#26231d): headings, bold emphasis, heavy sketch strokes, solid borders.
- **Graphite** (#4a463c): body/secondary text, default sketch strokes, section ledes.
- **Graphite Faint** (#635c4b): timecodes, attribution ("—AI" / "—you"), fine print, lite sketch strokes.
- **Code Slate** (#2b271d) with **Code Paper** (#efe9d8), **Code Amber** (#e8b04c) prompts, and **Code Comment** (#aca283): the only dark surface — terminal blocks in the call sheet, taped to the page at a slight tilt.

### Named Rules

**The Two-Hands Rule.** Graphite draws the draft; red draws the judgment. Content and illustration are ink/graphite; anything in red is annotation, emphasis, or interaction — and red is stroked or handwritten, never a filled panel.
**The One-Pigment-One-Job Rule.** Highlighter marks the spoken word, green stamps approval, blue stays in the technical margins. None of the three ever migrates into general UI accent duty.

## Typography

**Display/Body Font:** Jost (with Helvetica Neue, sans-serif)
**Handwriting Font:** Caveat (weights 500–700)
**Mono Font:** SF Mono (with Menlo, Consolas), `tabular-nums` for timecode
**Karaoke Specimen Font:** Jost 700, uppercase (English page). A zh-TW variant sets its specimens in Noto Sans TC 900 with `lang="zh-Hant"` instead — Chinese specimen text belongs only on that variant.

**Character:** Production paperwork meets a director's hand. Jost carries the printed layer — geometric, confident, tight at display sizes, letterspaced small caps for slates and labels. Caveat is the pen on top of it: larger than the print it annotates (19–23px), always red or graphite, always slightly rotated (±1–2deg).

### Hierarchy

- **Display** (700, clamp(38px, 5.4vw, 74px), 1.04, -0.015em): the H1 only; balanced wrapping, red span with hand-drawn SVG underline.
- **Headline** (700, clamp(30px, 3.4vw, 46px), 1.1, -0.01em): section H2s; one red-pencil phrase per headline, max-width 24ch.
- **Body** (400, 17px, 1.55): default copy; ledes cap at 60–68ch in Graphite with Ink `<b>` emphasis.
- **Annotation** (Caveat 500–700, 18–23px, 1.12): margin notes, hints, callouts, the closing credo; rotated ±1–2deg.
- **Label** (600, 11–13.5px, letterspaced .12–.26em, uppercase): scene slugs (SC.01 · IMPORT), loop-step roles, manifest headers, tool groups. Wider tracking for wider scope (.26em on the manifest header).
- **Mono** (13–13.5px, tabular-nums): timecodes, tool names, commands, code chips.
- **Karaoke Specimen** (Jost 700 uppercase, 21px in-frame / clamp(36px, 4.6vw, 58px) standalone): karaoke caption specimens ("CAT TAKES OFF"). The zh-TW variant swaps these to Noto Sans TC 900, `lang="zh-Hant"`.

### Named Rules

**The Pen-Over-Print Rule.** Handwriting always sits above and beside printed type at a larger size than the label scale it annotates; it never replaces headings, body copy, or interactive labels.

## Layout

Single-column desk, max-width 1340px, horizontal gutter `clamp(24px, 5vw, 72px)`, sections separated by `clamp(64px, 11vh, 130px)` of paper. The hero storyboard is a horizontally scrolling flex strip of fixed-size 9:16 frames (`--frame-w: 168px`, `--frame-h: 268px`; 158×274 under 640px) with `scroll-snap-type: x proximity` and hidden scrollbars; the scrub rail beneath caps at 1080px. Inside sections, content pairs a fixed illustrated object with a flexible text column that wraps under 900px (`flex-wrap`). Measure is enforced everywhere: 20ch H1, 24ch H2, 60–68ch ledes, 70ch captions. Breakpoints: 900px (annotation goes inline, tool columns 3→2) and 640px (tool columns→1, frames resize, screenshot callouts hidden, scrub hint drops below the rail).

## Elevation & Depth

Depth is physical, not UI elevation: objects are pieces of paper lying on a desk. Every shadow is small, soft, and ink-tinted (`rgba(38,35,29, …)`, never pure black), and heavier objects (the taped screenshot) throw longer shadows than index cards. Tape, tilt, and multiply-blended stamps do more depth work than shadows do. The one non-paper surface — the terminal code block — adds an inset 1px paper-colored ring instead of a border.

### Shadow Vocabulary

- **Card rest** (`box-shadow: 0 3px 14px rgba(38,35,29,.16), 0 1px 3px rgba(38,35,29,.12)`): storyboard frames; the shot-list card uses the lighter `0 3px 16px rgba(38,35,29,.13)`.
- **Heavy object** (`box-shadow: 0 10px 34px rgba(38,35,29,.28), 0 2px 8px rgba(38,35,29,.18)`): the taped editor screenshot.
- **Chip lift** (`box-shadow: 0 2px 6px rgba(38,35,29,.14)`): the bordered GitHub nav button.
- **Tape contact** (`0 1px 2–3px rgba(38,35,29,.1–.12)`): washi tape strips.

### Named Rules

**The Ink Shadow Rule.** All shadows are tinted with the ink color (rgba(38,35,29,α)); depth reads as paper stacking, and hover "lift" is a translate/rotate of the object, not a bigger shadow.

## Shapes

Barely-rounded paper corners: 2px (focus ring, callout card), 3px (chips, buttons, screenshot), 4px (frames, code blocks), 5–6px (stamps), 50% only for the numbered call-sheet circles. The defining form language is the hand-drawn line: every illustration stroke — frame borders, arrows, underlines, CTA rings, icons — is an SVG path with `stroke-linecap: round` passed through the `#pencil` turbulence filter (`feTurbulence baseFrequency 0.055, seed 7` + `feDisplacementMap scale 2.6`), with weight tiers heavy 2.6 / default 2 / lite 1.4. Rectangles are wobbly closed paths, never straight `<rect>` borders. Nothing hand-placed sits square: tape ±2–5deg, stamps 8–9deg, notes ±1.1–1.6deg, code blocks ±0.3deg, alternating sign by `nth-child`.

## Components

### Buttons

- **GitHub button (nav):** paper-card fill, 2px solid Ink border, 3px radius, 7px 15px padding, 15.5px/500 Jost with inline GitHub SVG. Hover: `translateY(-2px) rotate(-.5deg)`, background to white, springy ease `cubic-bezier(.2,1.4,.4,1)` over .15s.
- **Star CTA (primary):** no box at all — 21–24px/700 Jost text with a hand-sketched star icon (red stroke) inside a hand-drawn red circling ring (SVG loop, stroke-width 3, overshooting the text box by 6–10px). Hover: `rotate(-1deg) scale(1.03)`, same springy ease.
- **Focus (all):** `outline: 2px dashed var(--red); outline-offset: 3px`.

### Cards / Containers

- **Storyboard frame:** paper-card, 4px radius, card-rest shadow, wobbly hand-drawn SVG border floating 5px outside the box, optional washi tape at top center, labeled by a scene-slug row (label caps left, mono timecode right) and a red Caveat note beneath with a faint "—AI"/"—you" attribution.
- **Shot-list card:** paper-card, 5px radius, tape at top, letterspaced manifest header over a 2px ink rule, CSS-columns of mono tool names with dotted separators.
- **Taped screenshot:** real PNG at -0.5deg with tape at two corners, heavy-object shadow, and (desktop only) Caveat callout cards with red sketch arrows pointing into the image.

### Code blocks

- **Terminal:** code-slate background, code-paper text, 13.5px mono at 1.75 line-height, 4px radius, taped down at ±0.3deg; amber command names, muted comments. **Inline chip:** paper-card, 1px rgba(38,35,29,.15–.18) border, 3px radius, 13px mono.

### Stamps

Green border (3–4px solid), green text, 5–6px radius, uppercase letterspaced with a smaller-caps second line, rotated 8–9deg, `mix-blend-mode: multiply`. The scrub-driven hero stamp lands by scaling 1.9→1 with an overshoot ease.

### Lists

- **Loop steps / limits:** borderless rows split by 1.5px dashed rgba(38,35,29,.22) rules; label-caps role column (red for the human's row) + graphite body.
- **Call sheet:** hand-drawn numbered circles (44px, 2.5px ink border, -3deg) + title/why + taped terminal block; 1.5px solid rgba(38,35,29,.16) row rules.

### Navigation

Borderless Jost 500 15.5px links (no underline) beside the bordered GitHub button; link hover turns Red Pencil site-wide, underline offset 4px / thickness 1.5px where underlines exist.

### The Playhead Scrub (signature)

A dashed graphite rail (repeating-linear-gradient ticks) with an invisible full-width range input whose thumb is drawn as a red playhead (flag + 2.5px stem, `cursor: ew-resize`). Its 0–1 value drives the whole session: per-frame stroke reveal via `stroke-dasharray: 1; stroke-dashoffset: calc(1 - var(--r))` on `pathLength="1"` strokes, note fade-in past 85% of a frame's window, karaoke word highlight in SC.03, stamp landing in SC.04. On load the session draws itself once (5.2s, ease-out `1-(1-p)^2.2`), then hands the playhead to the visitor; `prefers-reduced-motion` renders the finished board statically (`apply(1)`).

## Do's and Don'ts

### Do:

- **Do** run every illustrated stroke through the `#pencil` filter (feTurbulence 0.055/seed 7 + displacement 2.6) with round linecaps and the heavy/default/lite (2.6/2/1.4) weight tiers.
- **Do** give every hand-placed object a small rotation and alternate the sign across siblings; keep print (headings, body, lists) square.
- **Do** keep red as drawing and writing — strokes, underlines, handwriting, the playhead — and give each supporting pigment only its diegetic job (highlighter=spoken word, green=approval, blue=technical margin, tape=fastening).
- **Do** tint every shadow with ink (rgba(38,35,29,α)) and express hover as a physical nudge (translate/rotate/scale with `cubic-bezier(.2,1.4,.4,1)`).
- **Do** drive motion from the playhead (or a single authored draw-in) and ship the finished, fully-drawn state under `prefers-reduced-motion: reduce`.
- **Do** set karaoke specimens in Jost 700 uppercase on the English page; on the zh-TW variant, set them in Noto Sans TC 900 with `lang="zh-Hant"` — Chinese specimen text appears only there.

### Don't:

- **Don't** use the category defaults this world was built against: dark heroes, glows/gradients-as-decoration, floating browser-chrome screenshots, or feature-card grids. The only dark surface is a taped-down terminal block.
- **Don't** draw crisp vector illustration or straight `<rect>` borders around frames; borders are wobbly filtered paths.
- **Don't** use pure black — ink is #26231d — or pure-black shadows on paper surfaces.
- **Don't** use radii above 7px on paper objects (circles are reserved for call-sheet step numbers).
- **Don't** fill panels or buttons with Red Pencil; red is never a background.
- **Don't** import the editor UI's dark violet theme (`ui/src/theme.css`) into this page, or this paper world into the editor — with one user-approved exception: the editor's Agent Presence elements (header paper strip + Inspector index card) are the paper world's sole embassy there; see the Scope note and `docs/superpowers/specs/2026-08-14-agent-presence-design.md`.
