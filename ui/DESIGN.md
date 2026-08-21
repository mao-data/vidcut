---
name: vidcut editor UI
description: One pair of hands, two desks — a grease-pencil cutting room by night, a storyboard paper desk by day.
colors:
  # ---- Dark (default, "cutting room / darkroom") ----
  charcoal-stage: '#131315'
  charcoal-bg: '#1a1a1c'
  charcoal-panel: '#202023'
  charcoal-panel-2: '#26262a'
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
  tape-blue-bright: '#a8cce8'
  alert-red: '#fb8a8a'
  signal-green: '#34d399'
  signal-green-text: '#6ee7b7'
  guide-amber: '#eab308'
  toast-danger-bg-dark: '#2a1620'
  # ---- Paper (light, "storyboard paper desk"; values inherited from ../site/DESIGN.md) ----
  paper: '#ede8dc'
  paper-card: '#f7f3e9'
  paper-card-2: '#efe9db'
  paper-note: '#fffdf6'
  paper-clip: '#e4dece'
  ink: '#26231d'
  graphite: '#4a463c'
  graphite-faint: '#635c4b'
  red-pencil: '#c0392b'
  red-pencil-deep: '#a02a1e'
  non-photo-blue: '#3a6484'
  non-photo-blue-deep: '#123a5e'
  stamp-green: '#2a7a45'
  stamp-green-deep: '#1f5c34'
  highlighter: '#f3d13d'
  toast-danger-bg-paper: '#f7e4df'
  # ---- Pastel chip family (timeline chips, user decision 2026-08-16; LightPink-anchored) ----
  chip-pink: '#e68593'
  chip-pink-text: '#4f0f18'
  chip-pink-dark: '#751e2b'
  chip-pink-dark-text: '#ffc4cd'
  chip-green: '#85e6a0'
  chip-green-dark: '#1c5e3c'
  chip-blue: '#85bde6'
  chip-blue-dark: '#234d6b'
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
  agent-card:
    backgroundColor: '{colors.code-slate}'
    textColor: '{colors.code-amber}'
    borderColor: 'rgba(232, 176, 76, 0.5)'
    rounded: '{rounded.embassy}'
    padding: '10px 12px'
    typography: '{typography.embassy-cap}'
  agent-card-offline:
    backgroundColor: '{colors.code-slate-off}'
    textColor: '{colors.code-amber-dim}'
    borderColor: 'rgba(156, 134, 84, 0.8)'
    rounded: '{rounded.embassy}'
    padding: '10px 12px'
  agent-card-paper:
    backgroundColor: '{colors.paper-card}'
    textColor: '{colors.graphite}'
    borderColor: 'rgba(38, 35, 29, 0.5)'
    rounded: '{rounded.embassy}'
    padding: '10px 12px'
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
the only warm light anywhere in the dark theme, is the embassy — the amber terminal
tag in the header and the amber terminal card in the AI column, the AI's two
premises. Its scarcity is the mechanism: because nothing else is warm, amber is
always the answer to "is the agent there?".

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
- Warm light belongs to the embassy alone — the agent's amber tag and index card
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

- **Code Amber** (`#e8b04c`) on **Code Slate** (`#241f16`): the embassy's terminal
  material — the AgentStrip tag and the AgentStatus index card — dark theme only.
  Offline steps to an unpowered brass (`#9c8654`) on a darker slate (`#1f1c15`).
  These `--ap-*` tokens are an isolated namespace: they neither share with nor fall
  back to the editor palette.
- **Alert Red** (`#fb8a8a`, dark) / **Red Pencil Deep** (`#a02a1e`, paper): danger
  only — destructive buttons, export failures, error toasts.
- **Signal Green** (`#34d399` / `#2a7a45`): agent-connected dot, overlay-track chips,
  and the Approve button.
- **Guide Amber** (`#eab308`, both themes): the snap guides drawn _on the video_.

### Neutral

- **Charcoal ladder** (dark): stage `#131315` → page `#1a1a1c` → panel `#202023` →
  panel-2 `#26262a` → popover `#2a2a2e`, with timeline clips at `#2b2b2e` and frozen
  clips at `#2e2e31`.
- **Paper ladder** (light): stage `#26231d` (unchanged) → page `#ede8dc` → panel
  `#f7f3e9` → popover `#fffdf6`, with clips at `#e4dece` and frozen clips at `#dcd9cd`.
  **`--panel-2` (`#efe9db`) is the one rung that steps _down_ from the panel** rather
  than up — on paper the only readable step is downward (same rule as `--surface`),
  so it is not "between panel and popover" here the way it is in the dark.
- **`--panel-2`** exists for the Chat composer and the user quote card only (see
  Chat composer & the user quote card). It is not a general-purpose surface: it
  carries no shadow and is not a float, which is what separates it from the popover
  ground it sits next to in the dark ladder.
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
fill. **Timeline chips are the carved-out exception since 2026-08-16 (user
decision):** they fill with the pastel chip family (see Chips below), which is
anchored on LightPink, not on the marking red — a pink sticker on the timeline, not
a red button. The rule still governs everything that is actually red: buttons,
panels, and any fill in the `--accent`/`--select-edge` marking family. Audit test:
if you can point at a _marking-red_ rectangle bigger than a chip, the rule is
broken.

**The One-Warm-Light Rule.** Warm light in the dark theme belongs to **the embassy
and nothing else** — the AgentStrip tag in the header and the AgentStatus index card
at the top of the AI column, which are the same amber-on-slate terminal material and
the same drawn hand. The rule is about the _territory_, not the object count: adding a third
embassy surface would need approval, but adding warm light to any non-embassy
element is simply forbidden. No other element may emit warm light or a colored glow
at rest; "the darkroom does not glow" applies to every resting state, and the AI-edit
flash is allowed only because it decays to zero within 1s.

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
`--accent-chip-bg` (né `--accent-wash`), and `--accent-faint` were a single hue's
three alpha steps in the old world and are now **three** different pigments —
neutral highlight, the pastel chip family (see Chips), and the red row-highlight —
because their meanings were always different. This is why `.seg.on` and `.badge`
are pulled back to chalk in the dark
theme: a red-outlined tab reads as "a red button", which is exactly what the
red-never-fills rule forbids — the paper theme made and corrected that same mistake.

## Typography

**UI Font:** Jost (variable, `wght` 400–700, self-hosted at
[`src/fonts/Jost-var.woff2`](src/fonts/Jost-var.woff2), OFL) — shared by both themes.
**Fallback chain:** `-apple-system`, `BlinkMacSystemFont`, then `PingFang TC` /
`Noto Sans TC`, then `sans-serif`.
**Mono / readouts:** `SF Mono`, Menlo, Consolas, monospace with `tabular-nums`.
**Handwriting:** Caveat is in the repo and declared, with zero consumers — and the
surface it was being held for (the agent index card) has since shipped without it.

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
- **Embassy cap** (600, 11px, 0.16em, uppercase): the embassy status word — the
  AgentStrip tag and the index card's head row, which share the `.ap-cap` spec.
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
legible at a glance. The exemption it was being kept for is now closed too — the
agent index card shipped in 2026-08, and its `—AI` / `—you` signatures are set in
the UI face at 10px in the `--who-*` pigment, because a signature that is decoration
in a landing page is _attribution data_ in a working panel. The `@font-face`
declarations and the woff2 files are still kept, but they are now a plain reserve
with no named consumer; they cost nothing, since a font with no matching computed
`font-family` is never downloaded.

**The Video-Is-Not-Chrome Rule.** The theme has no authority over the caption/text-card
rendering path (`CaptionLayer` reads `cap.style.fontFamily`; card fonts are injected
via `/api/fonts`). Those are the user's finished work; changing them would be editing
the user's output.

## Layout

**The shell is cut vertically first** (user decision 2026-08-16): a fixed header
(`.glass`, solid panel fill, 8px/16px padding) spans the full width, and everything
below it is split by one full-height rule into **the AI column** on the left and the
work area on the right. The work area is then cut horizontally: preview stage plus
the Captions/Properties panel on top, the timeline region underneath. The timeline
therefore starts at the AI column's right edge and no longer spans the window —
when the AI column collapses, the timeline simply gets wider.

Mechanically this is still one CSS grid (three columns × two rows), not a flex
column wrapping a second grid: `PanelResizer` converts pointer coordinates against
that single container's rect (`clientX - rect.left` on the left, `rect.right -
clientX` on the right), so splitting the AI column out into its own box would leave
those two expressions measuring different origins. The skeleton lives in two
declarations — the AI column takes `gridRow: 1 / 3` (full height, so it crosses the
timeline row) and the timeline takes `gridColumn: 2 / 4` (starting at the preview
column).

Both side columns are resizable and collapsible; collapse is instant while width
animates over 0.25s, so the reopen handle fades in on a matching delay rather than
co-existing with the closing panel.

**Right column: two tabs, Captions ⇄ Properties.** Properties carries what used to
be the left panel — canvas fill, the selected object's Inspector form, the Shortcuts
popover, and the idle "Select a clip / caption / overlay / audio to edit" prompt.
**Selecting anything switches the right column to Properties** (and expands it if
collapsed): that is the direct translation of the old reflex where clicking a clip
turned the left panel into its form. Deselecting does _not_ switch away — the user
pressed Escape or clicked timeline blank space, and bouncing them off the tab they
are reading would be a second, unasked-for move; Properties just falls back to the
idle prompt.

**Spacing rhythm: multiples of 4.** 4 (icon-to-text, adjacent controls), 8 (panel
block padding, control-row gaps), 12 (panel/card padding, header horizontal), 16
(card-grade padding). 2 is the only half step, reserved for places 20–26px tall
where 4 would burst the row. Odd values (3/5/7) are all normalized away. Two classes
of exception are not padding and do not follow the ramp: **geometry constants**
(`ROW_H` 70, `SUB_ROW_H` 35, `AUDIO_ROW_H` 35, `GUTTER_W` 32, `TRACKS_VIEW_H` 200,
handle hit-width 6 unselected / 12 selected — see Chips → Trim handles) which are
drag math and screenshot-comparison surface, and **video-world values** which are
project data.

**Timeline region.** The tracks sit in a fixed-height well (`TRACKS_VIEW_H` 200)
that scrolls on both axes — vertical scroll is headroom for more-than-four tracks.
A 32px track-header gutter (`GUTTER_W`) sticks to the left edge, one cell per track
(Film / Image / Captions / AudioLines, size 13, `--text-3` on solid `--panel` —
never the translucent well wash, chips scroll underneath it), row heights
byte-identical to the track rows beside them — and, like them, **borderless**: the
2026-08-17 line-reduction pass removed the 1px separators between tracks on both
sides of the gutter, so rows read by height rhythm and chip fill, not grid lines.
The ruler keeps its bottom border as the one structural line of the well, demoted
from `--line-strong` to `--line`, and carries tick marks on its bottom edge — 6px
at each labeled second, 3px at 55% opacity at the quarter divisions — that never
extend into the track area. The ruler sticks to the top;
the corner cell sticks on both axes and carries the highest z. The gutter lives
**outside** the content coordinate system: drag/seek/snap math anchors on the
content layer, and every "visible width" consumer (fit, zoom anchor, AI
auto-scroll) subtracts `GUTTER_W` from the scroll container's clientWidth.

**Icons: two sizes.** 14 for toolbar level (timeline toolbar, header export trigger),
13 for in-panel level (panels, panel buttons, popovers, inline markers). Exceptions
must be annotated at the call site; only two exist — size 11 inside timeline chips
(20–26px tall, 10–11px labels) and size 20 for the ReviewBar bot, which is an avatar
rather than an icon.

**Forms** use a two-column grid for x·y pairs — never three, because a third column
truncates a four-decimal position value and the user reads `-0.0` as if it were the
real number. The measurement was taken at the 200px minimum of the old left panel;
the forms now sit in the right column (240px minimum), which is more room, not
less — the rule stands and the number stays as the origin of it, since widening a
panel is not a reason to re-add a column that was removed for legibility.

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
- **Timeline-toolbar exception (user decision 2026-08-16):** buttons inside
  `.tl-toolbar` are ghost — no border, no resting fill; hover brings `--surface-2`,
  and the Snap on-state reads by `--accent-soft` fill + weight instead of a border.
  Scoped to that one row; every other panel keeps boxed buttons.
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

- Chip backgrounds are the **pastel chip family** (user decision 2026-08-16, after
  several rounds): opaque, anchored on LightPink `#FFB6C1` for hue, then muted to a
  dusty grade (HSV s .42 / v .90) so they stay saturated without shouting — the
  earlier translucent washes and their well-composites read as "part of the
  background" and looked see-through. Dark theme uses the same three hues as deep
  room-tones. Chip text is the same hue at a contrast-checked extreme (deep on
  paper, pale in the dark).
- **Caption chip:** pink — paper `#e68593` with `#4f0f18` text (5.76), dark
  `#751e2b` with `#ffc4cd` text (7.10). Stroke stays the red edge at 0.75 / 0.5
  alpha (higher in the dark: a grease pencil on charcoal loses more than a pencil
  on paper).
- **Audio chip:** blue — paper `#85bde6` with `#123a5e` text (5.81), dark `#234d6b`
  with `#a8cce8` text (5.32); 0.45 stroke.
- **Overlay chip:** green — paper `#85e6a0` with `#1f5c34` text (5.24), dark
  `#1c5e3c` with `#6ee7b7` text (5.07); 0.35 / 0.45 stroke.
- **Selected:** the marking-red ring in the dark theme (`--select-edge` `#c94f42`) and
  ink on paper; chips never gain a fill on selection.

**Trim handles (Plan 11, supersedes the 2026-08-16 hover-only geometry).** The
`.handle` rule is shared by all four trim-capable tracks — ClipBlock, AudioChip, the
Timeline-rendered caption chip, and the overlay chip — so one CSS change moves every
track at once; that sharing is the batch's deliberate leverage point, not an
accident. Two states:

- **Unselected:** unchanged from before — invisible by default (a permanently-visible
  white bar at every clip boundary read as broken UI), 6px hit-width, fades in on
  `.clipblk:hover` (`--tint-28`) and brightens further on direct `.handle:hover`
  (`--tint-50`). This is the CapCut convention: hover the clip, then the edge.
- **Selected — persistent, not hover-gated.** Selecting a clip means the user is
  actively working it, so its handles are visible and grabbable immediately: 12px
  hit-width **straddling the boundary**, not sitting inside it — 6px inside the chip,
  6px overflowing outward. (A first cut grew the 12px entirely inward from the
  boundary; on a narrow chip that crushed the remaining draggable body to ~4px, so
  the outward-straddling split replaced it.) The overflow is computed at the call
  site (`Timeline.tsx`'s `handleOffset`, mirrored in `ClipBlock.tsx`/`AudioChip.tsx`)
  as an inline negative offset — the shared `.handle` rule only owns width and paint,
  never position. A 2px grip mark (`--tint-50`, one step brighter than the `--tint-28`
  handle fill) sits centered in the handle to read as "grabbable," not decorative.
  **Narrow-clip overflow:** below 28px chip width, both selected handles overflow
  outward and clear each other — they used to overlap and fight for the pointer.
  **Selected chips also raise to `zIndex: 15`** (`ClipBlock.tsx`/`AudioChip.tsx`) so
  the overflowing handles paint over neighboring chips instead of going underneath
  them.
- **Danger (source-limit) state:** when a main-track out-handle is dragged to the
  clip's source-media limit (`probe.duration`, via `dragMath`'s max check), the
  handle repaints in `--danger` — same geometry, only the fill and grip color change
  (`.handle.danger`: `--tint-28`/`--tint-50` swapped for `color-mix(--danger, ...)`
  at the same two alpha stops). Pairs with the DragBadge showing `max` (below) so
  "can't pull this further" has both a color and a text signal instead of silently
  clamping. **Plan 12 Task 3** added the symmetric case: the main-track **in**-handle
  repaints the same way when dragged to `in <= 0` (source start, material exhausted —
  `dragMath`'s `isAtSourceMin`), and the **audio** out-handle repaints when it hits
  its own source-length ceiling. Same `.handle.danger` rule, no new visuals invented;
  pairs with the badge's `min`/`max` suffix (below).

**Main-track trim-in scroll compensation (Plan 12 Task 1).** Dragging the main
track's in-handle scroll-compensates every frame: `scrollLeft` is recomputed
_absolutely_ (start-of-drag `scrollLeft` + this frame's duration delta in px), not
accumulated incrementally — pinning the dragged edge under the pointer while the
clip's existing content and everything after it stay visually still on screen, and
earlier clips make room instead. Absolute recomputation (not accumulation) matters
because the browser clamps `scrollLeft` to `>= 0`: an accumulator that hits that
floor and then gets dragged back would drift out of sync with the real `scrollLeft`,
skewing every compensation afterward; recomputing from the same start point each
frame is immune to that. **The main-track trim-in snap line is gone** as part of the
same change — the old behavior snapped the clip's _right_ edge to content
coordinates, but under the compensation model the right edge (the clip's timeline
start) never moves and the left edge's content coordinate isn't what the user is
watching either, so neither has anything meaningful to snap to. `snapLine` stays
`null` for the whole gesture; the `in <= 0` hard stop is still enforced (by the
`trimIn` pure function's own clamp), it's just no longer visualized as a snap.
Trim-out is untouched — its right edge already tracked the pointer under Plan 11.

**DragBadge.** One component, shared by every drag gesture on the timeline (trim and
move alike — not a per-track widget), rendered at the Timeline's top layer rather
than inside any chip, so it never inherits chip corner radius or fill. It follows the
pointer/handle 1:1 with no CSS transition (the timeline's standing rule for anything
under an active drag). Content is gesture-dependent: trims show `duration (±delta)`
(e.g. `3.2s (−0.8s)`, switching to `m:ss` at 60s), moves show the clip's new start
time. A trim pinned at the source limit appends `max` (out-handle, or audio
out-handle); **Plan 12 Task 3** added the symmetric `min` suffix for the main-track
in-handle pinned at `in <= 0`. The two are mutually exclusive per drag (an in-handle
drag can only ever be `min`, an out-handle drag only ever `max`) and both append
rather than replace — the duration/delta numbers stay useful on their own, the
suffix just flags "this is the limit." It disappears on pointer-up — the badge is
drag feedback, not a persistent readout.

**Overlap lines (absolute-time tracks only — overlay/caption/audio).** When two
items on the same track share time, a 2px `--danger` line is drawn along the
overlapping sub-interval on the chip's top edge, `zIndex: 16` (one above the selected
chip's 15, so the line always paints on top). Purely a visual nudge, not a block —
overlap is sometimes intentional (BGM under a sound effect) — so it never disables
the drag. It reads the **committed doc**, not the in-flight drag preview: during a
drag the line stays where it was and only jumps to its new position on pointer-up.
The main track is exempt — its ripple layout is structurally non-overlapping, so the
check doesn't apply there.

### Chat composer & the user quote card

The Chat tab's composer is a **card, not a control row** (user decision 2026-08-17,
after Descript Underlord and the ChatGPT/Cursor composer convention). 2026-08-18 it
also gained **breathing room**: the `.panel-bar` separator above it retired, and the
card floats on 12px margins off the column's bottom and sides (8px toward the list) —
the glued-to-the-bottom-edge look was the user's complaint, and the competitor set
uniformly floats its composer. Corners are **14px, a chat-family exception** shared
with the quote card (same decision, "rounder"): the global `--r-card` scale is
untouched, and the value is theme-invariant because the softness is chat vocabulary,
not a paper/dark material difference. It sits on
`--panel-2` — a new ladder step between `--panel` and the popover ground, added for
exactly two consumers, this card and the quote card below. Dark `#26262a`
(text-1 11.87, text-2 6.06, text-3 4.56); paper `#efe9db` (12.94 / 7.77 / 5.48).
Like the index card it cannot separate from `--panel` tonally (1.08 dark, 1.09
paper), so its boundary is a **structural 1px `--line`**, not a lightness step.
Note the paper value moves _down_ the ladder while the dark value moves _up_: same
Surface-Overlay direction rule that governs `--surface`.

The textarea starts at 3 rows and auto-grows on `scrollHeight` to an 8-row ceiling,
then scrolls internally. The card owns the focus ring (`:focus-within`) because the
send button lives inside it — one ring for the whole writing surface, on the standard
2px/1px-offset spec (3px offset on paper).

**The send button is the second solid-accent block in the app.** It is a round
`--accent` fill with `--on-accent` glyph — the same two tokens as the Export button,
so it follows both themes automatically. Measured: **13.05:1** dark (`#1a1a1c` on
`#e3dfd4`), **14.14:1** paper (`#f7f3e9` on `#26231d`). **Round is a deliberate
exception** to the square-objects rule: the no-rotate/square vocabulary governs
_objects on the desk_, and this is a control at the composer's trailing edge where a
circular send key is a cross-product convention. Its scarcity is preserved — a solid
accent fill still means "the primary action here", and there is exactly one per surface.

**The user message is a light quote card; the AI message stays unframed.** This is a
**local amendment to the no-bubbles decision, not a reversal.** What bubbles cost is
two-sided symmetry: two speech shapes pushed to opposite edges, eating the width of an
already-narrow column. A single-sided card has none of that cost, and the two sides
are genuinely different kinds of text — what the user said is _a quoted instruction_
(short, scanned back for "what did I ask for"), what the AI said is _this panel's body
copy_ (long, read straight through). The card is `--panel-2` with a 1px `--line` and
the chat-family 14px corners, matching the composer, so "the things I typed" read as
one family. 2026-08-18 the two sides also took the cross-product **alignment split**:
user rows align right (the quote card capped at 85% width — a full-width card cannot
read as "right"), AI rows stay left and full-width. The AI column's own tabs are
**text links with a hairline divider** (`.tab-link` / `.tab-divider`, user decision
2026-08-18) — the right column keeps its `.seg` segments; the divergence is
deliberate: one is a work-panel segment control, the other is a chat product's light
tab row.
**Signature rows retired from Chat** (user decision, same day, superseding the
"survive on both sides" rule that stood for one day): with the alignment split and
the one-sided frame, a visible `AI` / `You` label was saying what the layout already
says. The attribution did not leave the DOM — each message row carries it as an
`aria-label`, because assistive tech cannot read alignment. The `--who-*` signature
colours remain the vocabulary of the index card and the activity feed; Chat simply
no longer participates. Audit tests: if the AI side ever gains a frame, this has
become a bubble layout; if a message row ever loses its `aria-label`, authorship has
become sighted-only.

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

It has a sibling, not a copy: the **AgentStatus index card** below.

Its identity is **the hand, not the paper**: a hand-drawn SVG ring and a deliberately
crooked frame path, both filtered through `#ap-pencil` for graphite noise and stretched
by `preserveAspectRatio="none"` so one path serves every width. The carrier follows
the theme — an amber terminal tag on charcoal, a taped paper slip on the paper desk
(`--ap-tape`, rotated −3.5°, with a 1px ink shadow) — while the hand never changes,
only its pen color (amber → graphite). It is the only element permitted a resting
rotation (−0.6°), declared once on the base rule so both themes share the angle.

Height budget: 16px ring + 5px vertical padding = 26px, under the header's 28px
content row. Recompute this before changing padding, type size, or ring size.

### AgentStatus index card (the embassy's second premises)

`.ap-card` pinned at the top of the **Activity tab**, above the activity feed — two
scales of the same question in one place: the card answers "what is happening now",
the feed answers "what has been done so far", and a user who has to reassemble those
from opposite edges of the screen is doing the interface's job.

**Where it lives has moved twice, both times by user decision.** 2026-08-16 pulled it
out of the Inspector's nothing-selected branch (selecting any object used to hide
it). 2026-08-17 moved it from "pinned above the column's tabs" into the Activity tab
itself, so the Chat tab gives its full height to the conversation. Presence is not
lost by this: the header AgentStrip is permanent and derives the same three states
from the same store, so the card is the second copy, not the only one — which is
precisely why it can live inside a tab. (The one-day-old `compact` variant retired
with the move; a card with a single home is always the full card.)

Same material as the tag and the **same hand** — `RING_PATH` is imported from
`AgentStrip.tsx` rather than copied, because a second copy would silently diverge and
no test can see the shape of a path. The `#ap-pencil` filter `defs` live in the strip
and are reached document-wide, so the card declares no `defs` of its own. Three
states off the same `agentPhase` derivation: **offline** (slate-off ground, brass
type, dashed ring, plus the `claude mcp add …` reconnect command), **idle** (solid
ring, `AGENT READY`, session readout), **working** (a `▸ tool mm:ss` mono line whose
seconds tick on an interval mounted only while working, plus the redrawing ring).

Two deliberate divergences from the tag, both app-over-landing calls:

- **The card is square** — no resting rotation. The tag is a 26px object where −0.6°
  reads as "stuck on"; the card is a multi-line data block, and the no-rotate rule
  names data rows explicitly (a tilted stack of rows reads as broken layout).
- **The `—AI` / `—you` signatures are not handwriting.** They take the same `--who-*`
  pigment as the row's source label and step down by _size_ (11 → 10px), never by
  alpha: `--who-you` at α 0.8 falls to 3.81:1 on the panel, out of semantic grade.

The card cannot separate from `--panel` tonally — `--ap-slate` against `#202023` is
1.01:1, and on paper `--ap-paper` against the paper panel is exactly 1.00:1 (the same
literal). Its boundary is therefore a **structural 1px rule**, computed to clear the
3:1 non-text threshold in all four combinations (idle 3.12 dark / 3.07 paper; offline
3.42 / 3.96), and the offline step changes _pigment_ rather than dropping alpha —
fading the line to α 0.12 does not read as "dimmed", it deletes the card's edge.

### Waveforms

The main-track clip no longer renders a waveform band (user decision 2026-08-16:
filmstrip fills the full `ROW_H`; the `--wave-clip-*` tokens currently have **no
consumer** and are kept only so the band can be restored by re-attaching the canvas).
The audio track is the sole waveform surface. Canvas cannot read CSS variables, so
`src/timeline/waveform.ts` looks the `--wave-*` tokens up through
`getComputedStyle` at draw time — as a _function_, not a
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
  (Timeline chips fill with the pastel chip family, which is not the marking red.)
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
- **Don't** set app text in a handwriting face — including the index card's `—AI` /
  `—you` signatures, which are attribution data. Caveat is retained in the repo as an
  unassigned reserve, not as a licence for any current surface.
- **Don't** put warm light on anything outside the embassy. Amber's scarcity is its
  function; the tag and the index card are the whole territory.
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
- **Don't** frame the AI side of a chat message. The user-side quote card is a
  deliberate single-sided amendment; framing both sides recreates the bubble layout
  the no-bubbles decision exists to prevent.
- **Don't** spend `--panel-2` on new surfaces without a decision. It was added for the
  composer and the quote card; a third consumer would make it a general elevation
  step, which the four-rung ladder deliberately does not have.
- **Don't** exceed a 7px radius on any paper object, or ship a half-pixel chrome font size.
- **Don't** copy the purple/cyan literals in `waveform.ts` into anything. They are a
  jsdom fallback that exists to prove the lookup mechanism, not a palette.
- **Don't** hard-code a theme-dependent value in a component's inline style. Inline
  style beats every author rule, which means the paper theme can only override it with
  `!important` — the reason `--shadow-*`, `--tint-*`, `--input-bg`, and the chip text
  shadows were all collected into tokens.
