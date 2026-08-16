---
name: vidcut editor UI
description: One pair of hands, two desks — a grease-pencil cutting room by night, a storyboard paper desk by day.
colors:
  # ---- Dark (default, "cutting room / darkroom") ----
  charcoal-stage: '#131315'
  charcoal-bg: '#1a1a1c'
  charcoal-panel: '#202023'
  charcoal-card: '#2b2b2e'
  charcoal-frozen: '#2e2e31'
  charcoal-popover: '#2a2a2e'
  chalk: '#e8e4da'
  chalk-dim: '#a8a49a'
  chalk-faint: '#918d84'
  chalk-solid: '#e3dfd4'
  grease-red: '#c94f42'
  grease-red-text: '#da7565'
  tape-blue: '#7a91a3'
  tape-blue-bright: '#9aafbd'
  alert-red: '#fb8a8a'
  signal-green: '#34d399'
  signal-green-text: '#6ee7b7'
  guide-amber: '#eab308'
  toast-danger-bg-dark: '#2a1620'
  # ---- Paper (light, "storyboard paper desk"; values inherited from ../site/DESIGN.md) ----
  paper: '#ede8dc'
  paper-card: '#f7f3e9'
  paper-note: '#fffdf6'
  paper-clip: '#e4dece'
  ink: '#26231d'
  graphite: '#4a463c'
  graphite-faint: '#635c4b'
  red-pencil: '#c0392b'
  red-pencil-deep: '#a02a1e'
  non-photo-blue: '#3a6484'
  non-photo-blue-deep: '#2d5878'
  stamp-green: '#2a7a45'
  stamp-green-deep: '#1f5c34'
  highlighter: '#f3d13d'
  toast-danger-bg-paper: '#f7e4df'
  # ---- Embassy (--ap-*, AI-presence carrier; never falls back to the editor palette) ----
  code-amber: '#e8b04c'
  code-amber-dim: '#9c8654'
  code-slate: '#241f16'
  code-slate-off: '#1f1c15'
  washi-tape: 'rgba(214, 192, 122, 0.55)'
typography:
  panel-title:
    fontFamily: "Jost, -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: '14px'
    fontWeight: 600
  body:
    fontFamily: "Jost, -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: '13px'
    fontWeight: 400
  control:
    fontFamily: "Jost, -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: '12px'
    fontWeight: 400
  label:
    fontFamily: "Jost, -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: '11px'
    fontWeight: 400
    letterSpacing: '0.4px'
  section-cap:
    fontFamily: "Jost, -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Noto Sans TC', sans-serif"
    fontSize: '10px'
    fontWeight: 600
    letterSpacing: '0.09em'
  embassy-cap:
    fontFamily: "Jost, -apple-system, 'Helvetica Neue', sans-serif"
    fontSize: '11px'
    fontWeight: 600
    letterSpacing: '0.16em'
  mono-readout:
    fontFamily: "'SF Mono', Menlo, Consolas, monospace"
    fontSize: '12px'
    fontWeight: 400
rounded:
  panel: '10px'
  card: '9px'
  control: '7px'
  embassy: '3px'
  paper-panel: '4px'
  paper-control: '3px'
spacing:
  half: '2px'
  xs: '4px'
  sm: '8px'
  md: '12px'
  lg: '16px'
components:
  button:
    backgroundColor: '{colors.charcoal-bg}'
    textColor: '{colors.chalk}'
    rounded: '{rounded.control}'
    padding: '6px 10px'
    typography: '{typography.control}'
  button-primary:
    backgroundColor: '{colors.chalk-solid}'
    textColor: '{colors.charcoal-bg}'
    rounded: '{rounded.control}'
    padding: '6px 10px'
  button-primary-paper:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.paper-card}'
    rounded: '{rounded.paper-control}'
    padding: '6px 10px'
  button-danger:
    backgroundColor: '{colors.charcoal-bg}'
    textColor: '{colors.alert-red}'
    rounded: '{rounded.control}'
    padding: '6px 10px'
  input:
    backgroundColor: '{colors.charcoal-bg}'
    textColor: '{colors.chalk}'
    rounded: '{rounded.control}'
    padding: '6px 8px'
    typography: '{typography.control}'
  popover:
    backgroundColor: '{colors.charcoal-popover}'
    textColor: '{colors.chalk}'
    rounded: '{rounded.control}'
    padding: '12px'
  badge:
    textColor: '{colors.chalk}'
    rounded: '8px'
    padding: '0 6px'
    typography: '{typography.section-cap}'
  agent-strip:
    backgroundColor: '{colors.code-slate}'
    textColor: '{colors.code-amber}'
    rounded: '{rounded.embassy}'
    padding: '5px 14px 5px 12px'
    typography: '{typography.embassy-cap}'
  agent-strip-offline:
    backgroundColor: '{colors.code-slate-off}'
    textColor: '{colors.code-amber-dim}'
    rounded: '{rounded.embassy}'
    padding: '5px 14px 5px 12px'
  agent-strip-paper:
    backgroundColor: '{colors.paper-card}'
    textColor: '{colors.graphite}'
    rounded: '{rounded.embassy}'
    padding: '5px 14px 5px 12px'
---

# Design System: vidcut editor UI

**Scope: this file documents the editor application UI only** — everything rendered
by `ui/src` and served at `:3845`. The landing page has its own, separate world
document at [`../site/DESIGN.md`](../site/DESIGN.md); the two cross-reference each
other and neither overrides the other. Where this file names a paper-world pigment
(ink, graphite, red pencil, non-photo blue, washi tape, code slate/amber), the value
is inherited from `../site/DESIGN.md` and is not re-invented here. Where the app
diverges from the landing page on purpose, the divergence is stated as a rule
(see **The App-Is-Not-Landing Rule**).

Normative source: [`src/theme.css`](src/theme.css). Every value below was read out
of the shipped stylesheet, not from the design specs — the specs
([`../docs/superpowers/specs/2026-08-14-dual-theme-design.md`](../docs/superpowers/specs/2026-08-14-dual-theme-design.md),
[`../docs/superpowers/specs/2026-08-14-agent-presence-design.md`](../docs/superpowers/specs/2026-08-14-agent-presence-design.md))
are decision history, `theme.css` is the current state.

## Overview

**Creative North Star: "One Pair of Hands, Two Desks"**

vidcut's editor is the same storyboard world as the landing page, seen at two times
of day. The light theme (`[data-theme='paper']`) is the storyboard paper desk:
ink and graphite drafting, a red pencil for judgment, non-photo blue for the
technical margins. The dark theme (`:root`, the default) is the traditional cutting
room after the lights go down: neutral charcoal walls, a white grease pencil for
line work, a red grease pencil for marks, and a desaturated tape-blue for the audio
side. The two themes are not a color inversion of each other — they are the same
hand holding a different pen on a different table, and every accent was reassigned
per consumer rather than hue-shifted as a family.

The room is deliberately colorless. All four dark ground steps are neutral charcoal
(R/G/B channels within 2 of each other): the walls carry no ambient tint so every
saturated pixel on screen belongs to a pen or to the video. The one exception, and
the only warm light anywhere in the dark theme, is the amber terminal tag in the
header — the AI's embassy. Its scarcity is the mechanism: because nothing else
glows, that tag is always the answer to "is the agent there?".

Density is workshop-grade rather than editorial: 13px body, an 11–14px chrome ramp,
4-multiple spacing, and two icon sizes. Things stay square and solid-lined. The
handmade vocabulary of the landing page (dashed rules, tilted objects, handwriting)
was tried in the app and pulled back out by the user after seeing the build — the
editor keeps the hand (the drawn ring, the wobbly frame, the spring easing) and
drops the paper craft that costs scan speed.

**Key Characteristics:**

- Two themes, one universe; dark is the default and is expressed as the _absence_
  of `data-theme`
- Neutral grounds, pigment reserved for pens; red is a marking pigment and never a fill
- Exactly one glowing element in the dark theme (the agent's amber tag)
- Solid 1px rules, square objects, print-legible type throughout the working surface
- Contrast is computed, not eyeballed: every semantic text token carries its measured ratio

## Colors

Two complete palettes over one token surface: the light theme redefines the same
custom properties rather than introducing a second naming scheme, so components
never branch on theme.

### Primary

- **Chalk** (`#e8e4da`, dark): the white grease pencil. Primary text, strokes, and
  the solid Export button (which uses a slightly settled `#e3dfd4` so it does not
  read as glowing). Contrast 13.69 on page ground, 12.80 on panel, 11.26 on popover.
- **Ink** (`#26231d`, paper): the paper world's heaviest pigment, and the only one
  weighty enough to be a solid button. Also the stage backing in _both_ themes.

### Secondary

- **Grease Red** (`#c94f42`, dark) / **Red Pencil** (`#c0392b`, paper): the marking
  system. Playhead and its round cap, timeline selection ring, caption chip stroke,
  current-caption row marker, review-card outline. The stroke-grade value is used
  for lines (3.02–3.87:1 against every ground the playhead crosses); text use steps
  to a lighter `#da7565` (dark) or a deeper `#a02a1e` (paper) so semantic text
  clears 4.5:1.
- **Tape Blue** (`#7a91a3` / `#9aafbd`, dark) / **Non-Photo Blue** (`#3a6484` /
  `#2d5878`, paper): the audio track, its chips, and the audio waveform. The
  darkroom equivalent of the paper world's blue pencil for technical margins —
  present and identifiable, never competing with the red.

### Tertiary

- **Code Amber** (`#e8b04c`) on **Code Slate** (`#241f16`): the AgentStrip terminal
  tag, dark theme only. Offline steps to an unpowered brass (`#9c8654`) on a darker
  slate (`#1f1c15`). These `--ap-*` tokens are an isolated namespace: they neither
  share with nor fall back to the editor palette.
- **Alert Red** (`#fb8a8a`, dark) / **Red Pencil Deep** (`#a02a1e`, paper): danger
  only — destructive buttons, export failures, error toasts.
- **Signal Green** (`#34d399` / `#2a7a45`): agent-connected dot, overlay-track chips,
  and the Approve button.
- **Guide Amber** (`#eab308`, both themes): the snap guides drawn _on the video_.

### Neutral

- **Charcoal ladder** (dark): stage `#131315` → page `#1a1a1c` → panel `#202023` →
  popover `#2a2a2e`, with timeline clips at `#2b2b2e` and frozen clips at `#2e2e31`.
- **Paper ladder** (light): stage `#26231d` (unchanged) → page `#ede8dc` → panel
  `#f7f3e9` → popover `#fffdf6`, with clips at `#e4dece` and frozen clips at `#dcd9cd`.
- **Text ramp**: chalk / chalk-dim / chalk-faint against ink / graphite /
  graphite-faint. All three steps are semantic-grade in both themes except one
  documented ceiling (see The Popover Text Rule).
- **Surface overlays** are directional: white 6/8% lifts a dark panel, but on paper
  the only readable step is _downward_, so `--surface` becomes ink at 5/9%.

### Named Rules

**The Darkest-Stage Rule.** `--bg-stage` is the darkest surface in the entire UI, in
_every_ theme. Light surroundings corrupt color judgment on the video, so the preview
backing stays `#26231d` even on the paper desk. This is a color-judgment constraint
that outranks the world metaphor; it is not "the dark theme happens to be dark".

**The Red-Never-Fills Rule.** Red is a pen. It draws lines, strokes, rings, round
caps, and marks — it is never a button background, a panel background, or any large
fill. Caption chips get a red _wash_ at α ≤ 0.12 so it reads as pigment laid on a
surface, not as a red panel. Audit test: if you can point at a red rectangle bigger
than a chip, the rule is broken.

**The One-Warm-Light Rule.** The AgentStrip amber is the dark theme's only warm,
glowing signal. No other element may emit warm light or a colored glow at rest;
"the darkroom does not glow" applies to every resting state, and the AI-edit flash
is allowed only because it decays to zero within 1s.

**The Three-Axis Danger Rule.** Danger red and marking red must separate on hue,
saturation, and luminance simultaneously. In the dark theme that is H8/S63%/L0.2857
for the grease pencil versus H0/S93%/L0.3878 for danger — a 1.36:1 luminance ratio.
Mnemonic: the crayon red is orange-leaning and settled; the alert red is pure and
bright. Never set danger to a value whose luminance ratio against the marking red
approaches 1.00.

**The Popover Text Rule.** `--text-3` is semantic-grade on panels (4.91:1) and on the
page ground (5.25:1) but only 4.32:1 on `--popover-bg`. Inside any floating layer,
semantic text uses `--text-2` (5.75:1). Decoration may stay on `--text-3`.

**The Per-Consumer Reassignment Rule.** When a pigment changes, reassign token by
token according to what consumes it, never by recoloring a family. Neutral UI state
(selection, tabs, primary action) goes to chalk/ink; the annotation layer (captions,
playhead, running timecode, the AI addressing you) goes to red. `--accent-soft`,
`--accent-wash`, and `--accent-faint` were a single hue's three alpha steps in the
old world and are now two different pigments, because their meanings were always
different. This is why `.seg.on` and `.badge` are pulled back to chalk in the dark
theme: a red-outlined tab reads as "a red button", which is exactly what the
red-never-fills rule forbids — the paper theme made and corrected that same mistake.

## Typography

**UI Font:** Jost (variable, `wght` 400–700, self-hosted at
[`src/fonts/Jost-var.woff2`](src/fonts/Jost-var.woff2), OFL) — shared by both themes.
**Fallback chain:** `-apple-system`, `BlinkMacSystemFont`, then `PingFang TC` /
`Noto Sans TC`, then `sans-serif`.
**Mono / readouts:** `SF Mono`, Menlo, Consolas, monospace with `tabular-nums`.
**Handwriting:** Caveat is in the repo and declared, with zero consumers.

**Character:** A geometric sans doing print work — even, upright, quietly
constructed, so that eleven-pixel labels stay scannable at working density. The
`@font-face` range is declared 400–700 because those are the weights the chrome
actually asks for; the file's axis is 100–900, but declaring only the real range
prevents the browser from synthesizing a fake bold and collapsing a step of the ramp.

### Hierarchy

- **Panel title** (600, 14px): Inspector form headings (Clip / Audio / Caption /
  Overlay). Deliberately one step heavier than body, not a body variant.
- **Body** (400, 13px): the `body` default; the single declaration point for the
  entire chrome, since all native controls take `font: inherit`.
- **Control** (400, 12px): buttons, inputs, selects, textareas, list rows, panel
  copy.
- **Label** (400, 11px, 0.4px tracking, uppercase for `.panel-head`): dense timeline
  markers, `.tag`, form field labels, hints, ruler ticks.
- **Section cap** (600, 10px, 0.09em, uppercase): form section headings, badges,
  timeline and audio chip labels.
- **Embassy cap** (600, 11px, 0.16em, uppercase): the AgentStrip status word only.
- **Mono readout** (12px tool name / 11px seconds, `tabular-nums`): elapsed time and
  timecodes.

### Named Rules

**The Four-Step Chrome Rule.** UI chrome type has exactly four sizes — 10 / 11 / 12 /
13 (plus 14 for panel titles). No half-pixel sizes exist and none may be added: a
half step is invisible as a distinction but forces you to measure to know which
level you are looking at. Video-world type (caption and overlay `fontSize`) is
project data, not chrome, and is outside this ramp entirely.

**The No-Handwriting-In-App Rule.** No handwriting face is used for any app text.
Caveat was shipped onto `.empty-note` and `.form .hint`, then removed by the user
after review: those sentences are the interface giving directions and must be
legible at a glance. The `@font-face` declarations and the woff2 files are kept
deliberately — reserved for the agent index-card surface — and cost nothing, since a
font with no matching computed `font-family` is never downloaded.

**The Video-Is-Not-Chrome Rule.** The theme has no authority over the caption/text-card
rendering path (`CaptionLayer` reads `cap.style.fontFamily`; card fonts are injected
via `/api/fonts`). Those are the user's finished work; changing them would be editing
the user's output.

## Layout

Three-region shell: a fixed header (`.glass`, solid panel fill, 8px/16px padding),
a middle row of left panel / preview stage / right panel, and the timeline region
across the bottom. Side panels are resizable and collapsible; collapse is instant
while width animates over 0.25s, so the reopen handle fades in on a matching delay
rather than co-existing with the closing panel.

**Spacing rhythm: multiples of 4.** 4 (icon-to-text, adjacent controls), 8 (panel
block padding, control-row gaps), 12 (panel/card padding, header horizontal), 16
(card-grade padding). 2 is the only half step, reserved for places 20–26px tall
where 4 would burst the row. Odd values (3/5/7) are all normalized away. Two classes
of exception are not padding and do not follow the ramp: **geometry constants**
(`ROW_H` 64, `SUB_ROW_H` 24, `AUDIO_ROW_H` 30, handle width 6) which are drag math
and screenshot-comparison surface, and **video-world values** which are project data.

**Icons: two sizes.** 14 for toolbar level (timeline toolbar, header export trigger),
13 for in-panel level (panels, panel buttons, popovers, inline markers). Exceptions
must be annotated at the call site; only two exist — size 11 inside timeline chips
(20–26px tall, 10–11px labels) and size 20 for the ReviewBar bot, which is an avatar
rather than an icon.

**Forms** use a two-column grid for x·y pairs — never three, because at the 200px
minimum panel width a third column truncates a four-decimal position value and the
user reads `-0.0` as if it were the real number.

## Elevation & Depth

The dark theme layers **tonally**: a four-step charcoal ladder plus white 6–8%
overlays does the structural work, and shadows are cold black drop shadows used
only for genuine floating (dragged clips, toasts, the preview stage, popovers, the
review card). The paper theme cannot layer tonally — same-colored paper on
same-colored paper — so it inverts the strategy: shadows are the primary depth cue
and every one of them is ink-tinted (`rgba(38, 35, 29, α)`), never black and never
glowing. Panels and the header pick up their own small ink shadows on paper where
the dark theme needs only a 1px line.

### Shadow Vocabulary

- **Float** (`0 6px 20px rgba(0,0,0,0.65)` / `0 6px 20px rgba(38,35,29,0.3)`):
  a clip being dragged.
- **Stage** (`0 8px 32px rgba(0,0,0,0.6)` / `… rgba(38,35,29,0.3)`): the preview frame.
- **Toast** (`0 8px 24px rgba(0,0,0,0.5)` / `… rgba(38,35,29,0.22)`).
- **Popover** (`0 10px 30px rgba(0,0,0,0.5)` / `… rgba(38,35,29,0.18)`) and
  **popover menu** (`0 12px 40px rgba(0,0,0,0.55)` / `… rgba(38,35,29,0.22)`).
- **Review card** (`0 12px 40px rgba(0,0,0,0.55)` / `… rgba(38,35,29,0.24)`).
- **Embassy landing shadow** (`0 3px 10px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.4)`
  dark; ink-tinted equivalents on paper): the tag sitting on the header.

### Named Rules

**The Ink-Shadow Rule.** On the paper desk, nothing glows. Every glow token becomes
an ink drop shadow: a selected clip is not lit up, it has been picked up slightly and
its shadow got longer. The consumers are all color slots in existing `box-shadow` /
`drop-shadow` declarations, so the geometry never changes with the theme.

**The Shadow-Follows-Its-Ground Rule.** A shadow's tint follows the surface it lands
on, not the theme name. The AgentStrip's landing shadow stays cold black in the dark
theme because it falls on a dark header — an ink-colored shadow there reads as a
muddy halo, not as depth.

**The Nudge-Not-Lift Rule.** Hover is expressed as a physical nudge —
`translate(0, -1px)` on `cubic-bezier(0.2, 1.4, 0.4, 1)` — never as a larger shadow.
`:active` returns to `translate(0, 0)`.

## Shapes

Corner language is a theme-level material statement: the dark theme uses 10px panels
/ 9px cards / 7px controls, and the paper theme cuts them down to 4 / 4 / 3, because
paper corners are cut rather than molded and 10px on paper reads as plastic. **No
radius above 7px is permitted on a paper object.** The embassy tag sits at 3px in
both themes (terminal/chip corner).

Borders are the other constant: **every rule in the app is a 1px solid line**, in the
theme's own `--line` (white 8% on charcoal, ink 18% on paper). Focus is a 2px solid
outline at 1px offset (3px on paper), in chalk on charcoal and red pencil on paper.
The single deliberate asymmetry is the paper header's 2px solid ink bottom rule — a
printing rule line under a shot-list manifest header — which is **not** ported to the
dark theme, where the vocabulary is pen strokes (1.5px frame, 2px ring) and a 2px
bright line across the header would read as a lit edge rather than a boundary.

The one dashed stroke that survives is `input:disabled` (a dashed border marks a
field that cannot be typed into), plus the offline agent ring, whose broken line
literally means "the connection is cut".

## Components

### Buttons

- **Shape:** softly rounded controls (7px dark, 3px paper), 1px solid border, 6px×10px padding.
- **Default:** white 6% surface on charcoal / a paper card lighter than the panel
  (`#fffdf6`) on paper — because a pressable thing steps _down_ in the dark and _up_
  on paper. Hover raises to 8% / pure white and strengthens the border; the object
  nudges up 1px on the spring easing.
- **Primary (Export):** the only solid bright block in the dark theme — a 135° chalk
  gradient with charcoal text (13.05:1) and a soft chalk glow; on paper it is solid
  ink with paper-white text (14.14:1) and an ink shadow. Hover pushes the gradient
  further in the same pigment (whiter in the dark, deeper on paper) — never a hue change.
- **Danger:** text and border in the alert red, transparent fill; hover adds an 8%
  alert-red wash. Never a filled red button.
- **Focus:** 2px solid outline, 1px offset (paper: red pencil, 3px offset).
- **Disabled:** 45% opacity, default cursor.

### Chips (timeline)

- **Caption chip:** red wash background (α 0.12 dark / 0.09 paper) with a red stroke
  at 0.75 / 0.5 alpha and a red-grade text label — the stroke alpha is higher in the
  dark theme because a grease pencil on charcoal loses more than a pencil on paper.
- **Audio chip:** tape-blue / non-photo-blue wash (0.12 / 0.1) with a 0.45 stroke and
  a bright-grade label.
- **Overlay chip:** stamp-green wash (0.14 / 0.1), 0.35 / 0.45 stroke, deepened green
  text.
- **Selected:** the marking-red ring in the dark theme (`--select-edge` `#c94f42`) and
  ink on paper; chips never gain a fill on selection.

### Cards / Containers

- **Panels** (`.panel-surface`) are solid `--panel`, 10px / 4px corners, separated by
  1px `--line`. On paper they additionally carry the 24px dot grid
  (`radial-gradient(rgba(38,35,29,.055) 1px, transparent 1.2px)`) — painted on the
  panels themselves, because the app skeleton covers `body` completely and a dot grid
  declared only on `body` is invisible in the editor.
- **Popovers** are one ladder step brighter than a panel, with a strong 1px border and
  the popover shadow; the export menu takes panel-grade corners and a deeper shadow
  because it floats above the header.
- **Timeline clips** sit on `--card` with a filmstrip over them; frozen clips fall
  back to `--clip-frozen-bg`, whose lightness ceiling is pinned by the playhead
  needing 3:1 against it.

### Inputs / Fields

- **Style:** control-grade type, 1px `--line`, 7px / 3px radius, 6px×8px padding.
  The fill is directional: a well cut into the dark surface (`rgba(0,0,0,0.25)`) and a
  whitened writing area on paper (`rgba(255,255,255,0.6)`).
- **Hover:** border strengthens only.
- **Disabled:** faint text, shallower fill, dashed border.
- **Checkboxes/radios** are exempt from full-width form styling; `accent-color`
  follows `--accent`.

### Navigation / Segmented Controls

`.seg` tabs are surface-filled with a 1px line and secondary text. Selected (`.seg.on`)
is a **neutral** state in both themes: chalk border, primary text, weight 600 on
charcoal; ink border, primary text, weight 600 on paper. Never the annotation red.

### AgentStrip (signature component)

The AI's embassy in the editor, and the one place where the landing page's world is
visibly present. It is a `<button>` in the header with three states derived from
agent phase: **offline** (unpowered brass, dashed hand-drawn ring, faded wobbly
frame, `NO AGENT`), **idle** (solid amber ring and frame, `AGENT READY`), and
**working** (the tag stretches, a mono tool name and elapsed `mm:ss` appear, and the
ring redraws itself on a 1.6s loop that completes at 62% and rests).

Its identity is **the hand, not the paper**: a hand-drawn SVG ring and a deliberately
crooked frame path, both filtered through `#ap-pencil` for graphite noise and stretched
by `preserveAspectRatio="none"` so one path serves every width. The carrier follows
the theme — an amber terminal tag on charcoal, a taped paper slip on the paper desk
(`--ap-tape`, rotated −3.5°, with a 1px ink shadow) — while the hand never changes,
only its pen color (amber → graphite). It is the only element permitted a resting
rotation (−0.6°), declared once on the base rule so both themes share the angle.

Height budget: 16px ring + 5px vertical padding = 26px, under the header's 28px
content row. Recompute this before changing padding, type size, or ring size.

### Waveforms

Canvas cannot read CSS variables, so `src/timeline/waveform.ts` looks the five
`--wave-*` tokens up through `getComputedStyle` at draw time — as a _function_, not a
constant, so a runtime theme switch repaints correctly. Rendering is a mirrored
envelope: a faint peak layer (α 0.3–0.35) with a solid RMS core (α 0.85) over a
midline, amplitude on a `sqrt` perceptual curve. The dark theme draws clips in chalk
grays and audio in tape blue; paper draws both in non-photo blue.

The literal fallback colors in `waveform.ts` are the **retired purple/cyan values**
and are intentionally left alone: they are reachable only when no stylesheet exists
(jsdom), and the unit tests assert them to prove the _lookup-with-fallback mechanism_
works, not to assert a color. They are not part of this palette and must not be
copied into any new surface.

## Do's and Don'ts

### Do:

- **Do** keep `--bg-stage` the darkest surface in the UI in every theme, including
  paper (`#26231d`).
- **Do** use red as a pen only: strokes, rings, caps, marks, and washes at α ≤ 0.12.
- **Do** reassign pigments per consumer when a color changes — neutral UI state to
  chalk/ink, annotation layer to red — and never recolor a token family wholesale.
- **Do** state a measured contrast ratio next to any new semantic color token; graphics
  clear 3:1, semantic text clears 4.5:1, and half-transparent foregrounds are
  alpha-composited against their real ground before the ratio is computed.
- **Do** switch to the dark theme by _removing_ `data-theme` (never by setting
  `data-theme="dark"`); the dark theme is `:root`, which is what makes it byte-identical
  to the pre-theme build and what makes `:root:not([data-theme])` a precise dark-only scope.
- **Do** express hover as a physical nudge on `cubic-bezier(0.2, 1.4, 0.4, 1)`.
- **Do** keep the `--ap-*` embassy palette isolated; it neither shares with nor falls
  back to the editor tokens.
- **Do** use 1px solid rules everywhere and keep every UI element square.
- **Do** put semantic text in floating layers on `--text-2`, not `--text-3`.

### Don't:

- **Don't** dash a divider, a border, or a focus ring. Dashed rules are the landing
  page's vocabulary; a working interface has to be clean and scannable (user decision,
  two rounds). The only survivors are `input:disabled` and the offline agent ring,
  where the broken line carries literal meaning.
- **Don't** rotate a UI element. Tilt is landing vocabulary and was withdrawn from the
  app; `.empty-note`, `.toast`, and `.btn-primary` are square. Beyond taste, four
  things must never rotate for functional reasons: the preview stage and video (a
  coordinate measurement surface — `ResizeObserver` conversion, overlay drag mapping,
  and the `verify:canvas` matrix read all assume no rotation, and rotation turns the
  rect into a bounding box), any timeline element (alignment reading is its job), data
  rows (`.rowline` — a stack of individually tilted rows reads as broken layout), and
  popovers.
- **Don't** set app text in a handwriting face. Guidance sentences must be legible at
  a glance; Caveat is retained in the repo for the agent index card only.
- **Don't** add a second glowing element to the dark theme. The amber tag's scarcity
  is its function.
- **Don't** give the playhead a gradient or a pencil-texture filter. A solid `#c94f42`
  line was forced by measurement: a deeper tail fails 3:1 against the clip surface, and
  a compliant tail has a 1.00 luminance ratio against the tip, so the "gradient" is
  invisible either way. A crayon stroke is uniform.
- **Don't** port the paper header's 2px ink rule into the dark theme, and don't add
  film sprocket holes anywhere. Both are print/landing metaphors; on charcoal a 2px
  bright band reads as a lit edge, not a boundary.
- **Don't** use red for a selected tab, a badge, a button fill, or a panel fill — it
  reads as "a red UI accent" and the paper theme already had to correct exactly that
  mistake.
- **Don't** exceed a 7px radius on any paper object, or ship a half-pixel chrome font size.
- **Don't** copy the purple/cyan literals in `waveform.ts` into anything. They are a
  jsdom fallback that exists to prove the lookup mechanism, not a palette.
- **Don't** hard-code a theme-dependent value in a component's inline style. Inline
  style beats every author rule, which means the paper theme can only override it with
  `!important` — the reason `--shadow-*`, `--tint-*`, `--input-bg`, and the chip text
  shadows were all collected into tokens.
