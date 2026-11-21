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
  icon button in chrome), 32 (dialog footer buttons), 40 (a large field and the button beside it). Rows: 28 (menus,
  palette, file tree), 32 (lists in the panel and dialogs), 52 (home rows).
- Alignment: controls side by side share one height and one centre line; controls stacked in a pane's head share its
  left and right edges. A key hint for a field sits inside the field. Measure it (the sweep's `misaligned`,
  `mixed-heights` and `edge` checks), do not eyeball it.
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
- **Button**, four kinds only. The frame's top bar carries no primary: its next step is a default button. *Primary*: ink fill, on-act text. *Default*: `--bg`, 1 px `--rule-strong`, ink text.
  *Ghost*: no border, `--ink-2`, hover `--hover`. *Danger*: default with red text; a destructive confirm is a red
  fill. All 28 px (24 in rows, 32 in dialog footers), padding 0 12 (0 8 at 24), 13 px 500, `--r2` (`--r1` at 24).
  A key hint is a `<kbd>` inside the button, after the label.
  *Pressed* (by the pointer, or by its key: `strike.js` gives it `.struck`): a `--press` fill, a soft shadow inside the
  top edge (`--press-in`, `--press-in-act` on a primary), and it gives to 97%, the way a pushed thing goes away from the
  eye. No edge at rest; it lands at once (50 ms) and eases back (140 ms). Halves of a split button, segments, tabs and
  the meter only shade, so no seam opens between neighbours.
- **Icon button**: 28 square (24 compact), `--r2`, 16 px icon in `--ink-2`, hover `--hover` + ink; pressed, the pad is
  `--press` and the glyph gives to 88%.
- **Key hint** (`kbd`): a keycap, its bottom border two pixels. When its key is pressed it bottoms out on one, and the
  control that key drives shows its press, if it is in view (`strike.js`).
- **Link button** (`.link`): inline text action, 12 or 13 px to match its line, `--ink-2`, hover ink + underline. Used
  for actions inside text or section headers ("All", "Rewrite", "Back to this change alone").
- **Input / select / scope button**: 28 px, `--bg`, 1 px `--rule-strong`, `--r2`, padding 0 8, 13 px; focus: border
  `--ink-3` (keyboard focus adds the blue ring). Large inputs (home Open box, dialog title): 40 px, 14 px.
- **Segmented control**: 24 px buttons inside a 28 px `--hover` track, `--r2` track, `--r1` buttons; pressed = `--bg` +
  1 px ring `--rule-strong` + ink text. Same everywhere (verdict, Write/Preview tabs are tabs, not segments).
- **Tabs**: text, 13 px 500, `--ink-3`; selected ink with a 2 px ink underline. Panel tabs and Write/Preview alike.
- **Chip** (a value you can act on: an attachment, a branch, a ref): 24 px, `--r1`, 1 px `--rule`, 12 px. A head and
  its base (`branch → main`) wrap as one unit.
- **Model picker**: the model and effort as words with a chevron (`Sonnet 5.5 · high ⌄`), 24 px, 13 px 500 `--ink-2`, no
  box; hover `--hover`. The spark only for Claude models. The same drawing in a line of links and beside a send button.
- **Pill** (a state you only read: open, draft, test, new, high risk): 18 px, `--r1`, 11 px 500, padding 0 8,
  `--hover` background, `--ink-2` text; semantic variants tint background and text with ok, warn or danger.
- **Group header in a list** (the file list's guide sections): on the rows' own grid, its number in their glyph column
  and its title on their text edge, 13 px 600 ink, two lines at most; a 1 px rule and 8 above it. Never caps.
- **Section header**: 11 px 600 caps (short labels only: caps never carry a sentence), tracking 0.05em, `--ink-3`; optional count (11 px mono `--ink-3`) after it, and
  an optional link button or icon button at the right. 16 above (24 between panel sections), 8 below.
- **Row** (file tree, menus, palette, Marks list, stack, home): one hover (`--hover`), one current (`--press`), one
  keyboard focus (2 px blue inset ring), `--r1` corners inside lists with padding, square in full-bleed lists.
  Leading glyph column, label, trailing meta column right-aligned with tabular figures.
  A key in a row is a plain 11 px mono figure in that trailing column, like a count, never a keycap.
- **Palette** (⌘K, and `f` for the repository): the top bar's title opened, as an address bar opens. Flush to the top
  of the window, square above and `--r3` below; its field is the top bar's own row, the title's icon kept in the
  title's place and the typed text on the title's text edge; the bar stays lit and a click on it closes the palette.
  560 wide, 72vh at most. Its rows are the file list's rows: 28 px, a 14 px glyph column (M / A / D for files, the PR
  or branch icon for changes, empty for commands, so every label shares one edge) and a trailing column of keys,
  counts and checks. Section headers sit on the rows' text edge. The change you are on is not listed (it is the
  title). One quiet line at the foot says what else the field takes. Home and windows under 760 px get it centred.
- **List box** (files in a dialog, commits, home lists): 1 px `--rule`, `--r3`, rows divided by 1 px `--rule`.
- **Mark row in the code**: one line, glyph at the code's text edge, 13 px, hover `--hover`.
- **File note**: a caption between an unfolded file's header and diff, aligned to the code's text edge where room permits.
  14 px `--ink-2` prose, 8 px above and below, with inline code in mono and the same colour. An earlier version is
  marked in 11 px amber. New notes fade in once over 120 ms, with reduced motion shown immediately.
- **Message** (chat and marks): who (13 px 600; Claude in orange), model meta 11 px `--ink-3`, body 14 px.
- **Status**: M / A / D / R letters (11 px mono 600: amber, green, red, ink-2); the pixel check for viewed; counts as
  tabular figures.
- **Empty state**: one line in `--ink-3` 13 px, with the one action that fills it as a link button.
- **Toast**: bottom centre, `--act` background, on-act text, `--r2`, 13 px; an action in it is underlined text. A
  commit's toast flips the new commit's id in from its parent's, split-flap cells one mono character wide (`receipt.js`).
- **Motion**: background and colour 120 ms `--ease`; nothing slides except dialogs (160 ms rise) and menus (none). A
  press is 50 ms in and 140 ms out. After a write the top bar's next step turns over to the one after it in the
  odometer's roll (three steps, 200 ms).
- **Mote's look**: he looks with his eyes, never by turning his head: his idle face with the pupils a pixel toward what he
  looks at, in eight directions, jumping at most every 120 ms and only when the direction has really changed, with a
  blink before a jump across his face. He looks at the pointer when it comes within 480 px, and at what just happened
  (the row of the file you viewed, the mark you made, the answer that landed, the stamp, the next step after a write),
  for 1.2 s; not while he is busy, with reduced motion, or in a hidden tab.
- **Sound**: off until it is turned on (⌘K), and then only as the consequence of an act: a wooden tick per file viewed,
  pitched up a pentatonic ladder by the share read (the last file resolves it), a stamp, a typebar for a commit, a
  plucked string for a push, a dull knock for a failed send, one bell for an answer that lands in a hidden tab. Nothing
  for typing, clicks or scrolling. Made in the page (`voices.js`), no files.

## Print textures
A few states are drawn as a print shop would show them instead of in flat colour. They are the only textures in the
app, and they follow one set of rules (screens in `web/js/dither.js`).
- **Where**: only where nothing is being read. The opening state (the forme), the state of a change that could not
  open (the moiré), the dim behind a write's dialog (the tone screen), and the desk under Mote (the lens's light).
  Never behind code, prose or glass, with two exceptions: Mote floats over the diff's bottom-right corner, so his light,
  no wider than his feet, can land on the end of a line (drag him off it); and the approval's stamp is pressed over the
  diff for 1.7 s, its ink multiplied into the page so the code stays legible through it. The stamp leaves its
  impression on the pull request in the inspector, a row of its own.
- **What draws them**: the change's own state, never a picture. The forme has one dot per changed line (past 2,560 a
  dot stands for several), as GitHub counts them before the fetch; the daemon sends the counts on its progress lines. The moiré's two screens are turned by the base's and the head's names. The tone's
  weight is how hard the write is to undo: local 25%, public 37.5%, destructive 56%, each a quarter heavier in dark,
  nearly even (a little lighter round the dialog).
  The lens's spot gathers as the share of lines left falls. The stamp prints the head you approved and the day, seeded
  by that head (the same head always prints the same stamp); its impression slips out of register when the head moves on.
- **Screens**: the app's 4×4 Bayer matrix (`--d0`..`--d16`, one cell to a device pixel, or to an art pixel on Mote's
  grid; the tone screen uses 1 CSS px cells, a fine screen rather than a grey), hairline line screens, and letterpress
  dots. Every one is drawn at device pixels, never scaled or smoothed.
- **Ink**: the page's own (`--ink`, `--ink-3`, black under dark dialogs, `--hi` for light). Red only for a
  destructive write; amber only for the impression's second plate, when the head has moved past your approval (changed
  since). Blue and orange keep their one job: no texture uses them.
- **Motion**: frame-stepped, at 12 fps at most (the brayer's passes; the tone screen alone fades in, with its dialog). With
  reduced motion each is the still that says the same thing.

## Model-written text
The map, the guide's heads and the TLDR are prose a person reads. Code in them is the mono face in the text's own
colour, no chip; a place is shown as `file.go:123` with the full path on hover. Chat answers keep chips.
