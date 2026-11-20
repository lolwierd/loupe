# Components: the one way each thing is drawn

Every control in loupe is one of the components below, drawn exactly this way. A surface that needs something
else gets a new entry here first. Values are tokens from the top of `web/style.css`.

## Scale
- Spacing: `--s1..--s6` = 2, 4, 8, 12, 16, 24 px. Nothing else.
- Type: `--t-meta` 11 (labels, meta, counts), `--t-mono` 12 (code-ish values, paths, kbd), `--t-ui` 13 (all control
  and body text in chrome), `--t-read` 14 (reading text: answers, TLDR, why), `--t-title` 16 (one title per surface).
- Weights: 400 body, 500 controls and row titles, 600 titles and section labels. No 700.
- Radii: `--r0` 2 (checkbox), `--r1` 4 (chips, pills, kbd, small buttons inside rows), `--r2` 6 (controls: buttons,
  inputs, selects, the scope button, icon buttons), `--r3` 8 (surfaces: lists, cards, menus, dialogs, the palette).
  Nothing is fully round.
- Heights: 24 (compact: in-row actions, chips, segmented buttons), 28 (standard: every button, input, select and
  icon button in chrome), 32 (dialog footer buttons). Rows: 28 (menus, palette, file tree), 32 (lists in the panel and
  dialogs), 52 (home rows).
- Icons: 16 in icon buttons, 14 beside 13 px text, 12 beside 11 px text. Line icons 1.5 stroke. Pixel sprites only:
  the spark (Claude), the check (viewed), avatars.

## Colour jobs (one each)
- Ink (`--act`, `--ink`): acting. Primary buttons, checks in menus, checked boxes, your marks.
- Blue (`--pencil`): somewhere to go. Text links and the keyboard focus ring. Nothing else.
- Orange (`--claude`): Claude itself. The spark and the word Claude. Nothing else.
- Green (`--ok`): viewed or passing. Amber (`--warn`): changed or uncommitted, and risk. Red (`--danger`): failing or
  destructive.
- Surfaces: `--bg` (code, fields), `--raise` (menus, dialogs), `--glass` (frame), `--hover`, `--press`.

## Components
- **Button**, four kinds only. *Primary*: ink fill, on-act text. *Default*: `--bg`, 1 px `--rule-strong`, ink text.
  *Ghost*: no border, `--ink-2`, hover `--hover`. *Danger*: default with red text; a destructive confirm is a red
  fill. All 28 px (24 in rows, 32 in dialog footers), padding 0 12 (0 8 at 24), 13 px 500, `--r2` (`--r1` at 24).
  A key hint is a `<kbd>` inside the button, after the label.
- **Icon button**: 28 square (24 compact), `--r2`, 16 px icon in `--ink-2`, hover `--hover` + ink, active `--press`.
- **Link button** (`.link`): inline text action, 12 or 13 px to match its line, `--ink-2`, hover ink + underline. Used
  for actions inside text or section headers ("All", "Rewrite", "Back to this change alone").
- **Input / select / scope button**: 28 px, `--bg`, 1 px `--rule-strong`, `--r2`, padding 0 8, 13 px; focus: border
  `--ink-3` (keyboard focus adds the blue ring). Large inputs (home Open box, dialog title): 40 px, 14 px.
- **Segmented control**: 24 px buttons inside a 28 px `--hover` track, `--r2` track, `--r1` buttons; pressed = `--bg` +
  1 px ring `--rule-strong` + ink text. Same everywhere (verdict, Write/Preview tabs are tabs, not segments).
- **Tabs**: text, 13 px 500, `--ink-3`; selected ink with a 2 px ink underline. Panel tabs and Write/Preview alike.
- **Chip** (a value you can act on: an attachment, a branch, a ref): 24 px, `--r1`, 1 px `--rule`, 12 px.
- **Pill** (a state you only read: open, draft, test, new, high risk): 18 px, `--r1`, 11 px 500, padding 0 8,
  `--hover` background, `--ink-2` text; semantic variants tint background and text with ok, warn or danger.
- **Section header**: 11 px 600 caps, tracking 0.05em, `--ink-3`; optional count (11 px mono `--ink-3`) after it, and
  an optional link button or icon button at the right. 16 above (24 between panel sections), 8 below.
- **Row** (file tree, menus, palette, Marks list, stack, home): one hover (`--hover`), one current (`--press`), one
  keyboard focus (2 px blue inset ring), `--r1` corners inside lists with padding, square in full-bleed lists.
  Leading glyph column, label, trailing meta column right-aligned with tabular figures.
- **List box** (files in a dialog, commits, home lists): 1 px `--rule`, `--r3`, rows divided by 1 px `--rule`.
- **Mark row in the code**: one line, glyph at the code's text edge, 13 px, hover `--hover`.
- **Message** (chat and marks): who (13 px 600; Claude in orange), model meta 11 px `--ink-3`, body 14 px.
- **Status**: M / A / D / R letters (11 px mono 600: amber, green, red, ink-2); the pixel check for viewed; counts as
  tabular figures.
- **Empty state**: one line in `--ink-3` 13 px, with the one action that fills it as a link button.
- **Toast**: bottom centre, `--act` background, on-act text, `--r2`, 13 px; an action in it is underlined text.
- **Motion**: background and colour 120 ms `--ease`; nothing slides except dialogs (160 ms rise) and menus (none).
