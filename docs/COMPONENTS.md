# Components: the one way each thing is drawn

Every control in loupe is one of the components below, drawn exactly this way. A surface that needs something
else gets a new entry here first. Values are tokens from the top of `web/style.css`.

## Scale
- Spacing: `--s1..--s6` = 2, 4, 8, 12, 16, 24 px. Nothing else. `--off` (8 px) names one use of it: how far a box that
  appears under the pointer stands off its ink.
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
  the spark (Claude), the check (viewed), avatars, and the loupe (the mark; with an arrow rising in its lens, an
  update to loupe).

## Colour jobs (one each)
- Ink (`--act`, `--ink`): acting. Primary buttons, checks in menus, checked boxes, your marks.
- Blue (`--pencil`): somewhere to go. Text links and the keyboard focus ring. Nothing else.
- Orange (`--claude`): Claude itself. The spark and the word Claude. Nothing else.
- Green (`--ok`): viewed or passing. Amber (`--warn`): changed or uncommitted, and risk. Red (`--danger`): failing or
  destructive.
- Surfaces: `--bg` (code, paper), `--chrome` (the frame: top bar, files, inspector), `--raise` (menus, dialogs), `--hover`, `--press`.

## The plain ground
Everything you read or press is flat paint: type, thin rules, flat ink, and keys in whole pixels. **Nothing blurs.**
There is no blurred shadow, no glow, no glass and no gradient of light anywhere in the app (a key's skirt is a
`box-shadow` with no blur radius), and no dither on any control,
menu or card (`test/ground.test.mjs` keeps this). Dither is a plate (see Plates), and a plate is never part of a control.
- **What stands up, what is sunk**: what you press stands up out of the sheet as a key (buttons, chips, a status pill
  you can press, a select, a key, the chosen segment, the + that starts a mark); what you write in or only read is sunk
  into it (fields, composers, the draft in the code, a dialog's message box, the palette's field row, read-only chips
  such as a route's branch names, the segmented control's channel, what the map shows outside this repository).
- **A key** is a flat face and a skirt of solid shade below it: one pixel for a thing standing low, two for the act
  and for anything under the pointer. In dark it also has a lit line inside its top (`--lit`); in light the paper's own
  contrast is enough. Pressing a key sends it down by its skirt: the skirt goes, the face dims a touch (`--face-down`),
  one line of shade shows under its top edge (`--edge-in`), and the key travels one pixel (two for the act). A latch
  stays down while it is on: the top bar's Files, Map and Inspector toggles.
  Halves of a split button, segments, tabs and the tally do not travel, so no seam opens between neighbours.
- **Ghosts**: everything else you can press lies flat in the page until the pointer makes it a key: ghost and icon
  buttons, a file's Viewed box (viewed or not: its box says which), link buttons (a key round their words, standing
  out by its padding so the words keep their place), the model picker, the map card's title, an open mark's place
  (`file · line`), a pull request's figures, "N more lines", a hidden mark's pin, a toast's action (on the ink,
  keeping its underline), and tabs (a key shows behind the word; the selected tab keeps its ink underline).
- **Two heights**: the act (a primary, ink) stands two pixels at rest; a default (secondary) button, a chip you can
  press and the scope button stand one (`--raised-soft`) and rise to two (`--raised`) only under the pointer, so a
  page of secondary actions stays quiet and the act is the one thing standing. (The bin's scope picker and a file's
  Viewed box are ghosts, and read-only chips are sunk.)
- **No outlines.** Nothing is told from its ground by a line drawn round it: a thing is its fill, a step off what it
  sits on. The rules that stay divide (panes, headers, rows, a table's rows); none boxes a thing in. Checkboxes keep
  their square, which is the control itself, and the map's parts are a drawing. With forced colours, which drop fills,
  what lost its outline takes the system's rule back (its border is kept, transparent, so nothing moves).
- **A well** (`--well`): its floor alone, a step darker than the sheet (`--floor`), no lip and no sides. Writing in it
  changes nothing round it: the caret is the focus mark, from the pointer or the keyboard alike, so a field takes no
  blue ring.
- **On white paper** (the diff column, the whole-file viewer, and what floats: menus, tips, the palette, dialogs) a
  face cannot be paler than its ground, so there a key's face is a tint of ink and a well's floor a lighter one
  (`--face-paper`, `--floor-paper`); the chosen segment is paper itself in the tinted channel. In dark the same values
  serve both grounds.
- **What floats** over the page casts nothing and has no rule; its fill sets it apart. With nothing behind it (menus,
  tips, the selection's tools, the back slip, Mote's word and label) it is `--float-fill`, a step of ink
  off both the sheet and paper (lighter than both in dark, a pale grey in light), and a key in it is a step off that
  fill. On a backdrop (the palette, dialogs) it is paper, and the dimmed page behind it is the edge. A toast is ink.
- **The frame** (top bar, files, inspector) is the sheet: `--chrome`, flat and opaque, with a thin rule where it meets
  the code. A file's header that sticks over its code is opaque paper with its rule.
- **One list**: the composite reliefs (`--raised`, `--raised-soft`, `--flat`, `--well`, `--ink-raised`,
  `--pressed`, `--ink-pressed`, the split button's halves) are the same eight shadows in
  the same order (five inset: the top edge, the sides, three spares; three outer: the skirt and two spares), unused
  ones transparent (`--t0`, `--o0`), so a press moves from one to the other instead of jumping. None has a blur radius.
- **Edges that stay**: checkboxes and the map's parts. A map part is paper with a thin rule; a part of the change takes
  an ink rule (`--ink-2`); a part outside this repository is a floor with no rule. List boxes, the map card and a quote
  you can press (above a mark's thread) are fills with no rule: paper on the sheet, a well in a dialog.
- **A box under the pointer**: a control that lies flat until the pointer finds it (a link, a picker, a tab, the map's
  toggle, a toast's action, a row of Marks) shows a box that stands 8 px (`--off`) off its first and last ink, on both
  sides alike: an icon's ink, not its square, so a leading icon or a trailing chevron is pulled in by its own empty
  margin. Where such a control starts or ends a line its words keep their place: the padding is taken back by a margin
  of the same size, and the box reaches into the gutter. The next thing in its row is 16 px away, so the box comes no
  nearer a neighbour's ink than its own; it keeps at least 4 px from an edge of the surface it sits in. A box is as wide
  as what it holds, never the row. A link inside a sentence has no room for a box: it carries a thin rule under its
  words and takes the ink under the pointer. A link that is one icon is boxed as an icon is: square, 4 px round the glyph.
- **Forced colours** drop every shadow, so there keys take a `ButtonText` rule, wells a `CanvasText` one, a focused
  well the system's `Highlight` ring and the chosen segment an underline; no plate is pulled behind a dialog.

## Components
- **Button**, four kinds only. The frame's top bar carries no primary: its next step is a default button. *Primary*:
  a key of ink (`--ink-raised`), on-act text: the one thing standing two pixels at rest. *Default* (every
  secondary action): a low key (`--face`, `--raised-soft`), ink text, no border; under the pointer it stands two pixels
  (`--raised`).
  *Ghost*: lies flat in the sheet, `--ink-2`; under the pointer it is a low key (`--face`, `--raised-soft`). *Danger*: default with
  red text; a destructive confirm is a red key. All 28 px (24 in rows, 32 in dialog footers), padding 0 12 (0 8 at
  24), 13 px 500, `--r2` (`--r1` at 24). A key hint is a `<kbd>` inside the button, after the label: a chip of the button's own ink, with no outline.
  *Pressed* (by the pointer, or by its key: `strike.js` gives it `.struck`): sent down by its skirt (`--pressed` on
  `--face-down`; a primary `--ink-pressed` on its ink mixed 90% with the sheet), travelling one pixel, two for the act. It
  lands at once (50 ms) and eases back (140 ms). A split button is one key scored between its halves (a line of
  shade); its halves, segments, tabs and the meter only shade, so no seam opens between neighbours.
- **Icon button**: 28 square (24 compact), `--r2`, 16 px icon in `--ink-2`, flat in the sheet; under the pointer its pad is a low
  key (`--raised-soft`) + ink; pressed, the pad goes down (`--pressed`) and the glyph gives to 88%.
- **Key hint** (`kbd`): a keycap, a small face whose skirt is two pixels of shade. When its key is pressed it bottoms
  out on one, its face dimmed, and the control that key drives shows its press, if it is in view (`strike.js`). In a menu
  or the palette, and in the find field, a key is a plain figure.
- **Link button** (`.link`): a text action, 12 or 13 px to match its line, `--ink-2`, a ghost: under the pointer a
  low key shows round its words (`--raised-soft`; 8 px of padding, `--off`, with 8 px taken back by margin, so the words keep their place),
  a press sends it down. Used for actions inside text or section headers ("All", "Rewrite", "Back to this change alone").
- **Input / select / scope button**: 28 px, `--r2`, padding 0 8, 13 px, no border. An input (and a composer, and a
  dialog's message box) is a well on `--floor`; writing in it, its caret is the focus mark, with no ring (with forced
  colours, the system's highlight ring). A select is pressed, so the scope button is a key; the bin's own lies flat until the pointer makes it one. Large
  inputs (home Open box, dialog title): 40 px, 14 px.
- **Segmented control**: 24 px buttons inside a 28 px channel sunk into the sheet (`--floor`, `--well`), `--r2`
  channel, `--r1` buttons; the chosen one is a low key in it (`--face`, `--raised-soft`; paper itself on white paper) with ink text. Same everywhere (verdict, Write/Preview tabs are tabs, not segments).
- **Tabs**: text, 13 px 500, `--ink-3`; selected ink with a 2 px ink underline. Under the pointer a low key shows behind
  the word (28 px in a 40 px tab row; on the map's tabs, 26 px reaching 8 px past the word), pressed, down. Panel tabs,
  Write/Preview and the map's tabs alike; a map tab already chosen shows none.
- **Chip** (a value you can act on: an attachment, a branch, a ref): 24 px, `--r1`, a low key (`--face`,
  `--raised-soft`), 12 px; pressed, down. A head and
  its base (`branch → main`) wrap as one unit.
- **Model picker**: the model and effort as words with a chevron (`Sonnet 5.5 · high ⌄`), 24 px, 13 px 500 `--ink-2`, a
  ghost: it lies flat and is a low key under the pointer (`--raised-soft`), 8 px off the spark's first ink and the chevron's last. The spark (the pixel sprite, still: the one spark) only for Claude models. The same drawing in a
  line of links and beside a send button, and always before the action it sets ("Sonnet 5.5 · low ⌄ Write it",
  "… Regenerate"). One picker and one Regenerate for the brief: the Overview's, beside the line that says what wrote it.
- **Pill** (a state you only read: open, draft, test, new, high risk): 18 px, `--r1`, 11 px 500, padding 0 8,
  `--hover` background struck into the sheet (a line of `--shade-2` inside its top), `--ink-2` text; semantic variants
  tint background and text with ok, warn or danger.
- **Group header in a list** (the file list's guide sections): on the rows' own grid, its number in their glyph column
  and its title on their text edge, 13 px 600 ink, two lines at most; a 1 px rule and 8 above it. Never caps.
- **Section header**: 11 px 600 caps (short labels only: caps never carry a sentence), tracking 0.05em, `--ink-3`; optional count (11 px mono `--ink-3`) after it, and
  an optional link button or icon button at the right. 16 above (24 between panel sections), 8 below.
- **Row** (file tree, menus, palette, Marks list, stack, home): one hover (`--hover`), one current (`--press`), one
  keyboard focus (2 px blue inset ring), `--r1` corners inside lists with padding, square in full-bleed lists.
  Leading glyph column, label, trailing meta column right-aligned with tabular figures.
  A key in a row is a plain 11 px mono figure in that trailing column, like a count, never a keycap.
  In a menu, a row's icon says what kind of thing the row is (a chat or a linked session, a Claude or a Codex model),
  never what it does, so actions carry none; a rule sits only between rows (never first, last or twice), and a row that cannot be undone asks in its own
  place: its first pick turns the label to "Delete it?" on a faint red fill for 3 s, the second does it. Never the
  browser's `confirm()`; a step that needs more than a question is a dialog, weighted by how hard it is to undo.
- **Stack row**: keep the PR state or “this one” in the trailing meta column. Append “by commits” in the same quiet
  text for a relationship inferred from Git history. A landed parent keeps its “merged” state.
- **Palette** (⌘K, and `f` for the repository): the top bar's title opened, as an address bar opens. Flush to the top
  of the window, square above and `--r3` below; its field is the top bar's own row, the title's icon kept in the
  title's place and the typed text on the title's text edge; the bar stays lit and a click on it closes the palette.
  560 wide, 72vh at most. Its rows are the file list's rows: 28 px, a 14 px glyph column (M / A / D for files, the PR
  or branch icon for changes, empty for commands, so every label shares one edge) and a trailing column of keys,
  counts and checks. Section headers sit on the rows' text edge. The change you are on is not listed (it is the
  title). One quiet line at the foot says what else the field takes. Home and windows under 760 px get it centred.
- **Dialog**: its title is what it will do, a verb and its object ("Commit 2 files on token-bucket", "Push
  token-bucket", "Approve acme/widgets#12"), from the moment it opens; the preview only makes it exact. The body is what
  you write, or, for a dialog with nothing to write, what will happen drawn as itself (a push: the branch → its remote
  ref as chips, and the commits that go), never a list of one bullet. The footer says what else comes of it.
- **Updating loupe** (`update.js`; the daemon's side is `src/update.mjs`): when the copy loupe runs from is behind its
  source's main (the clone it runs or was promoted from, or that clone's origin), it asks once per new commit with a
  toast ("loupe can update: 3 new commits on origin/main." and **See what changes**), on home and on a change alike;
  after that an icon button keeps the offer (the loupe's own pixel mark with an arrow rising in its lens, in the mark's
  blue: the first of the top bar's tools, and at the end of home's name row, there only while an update waits or runs,
  its title the offer), as do home's footer and ⌘K.
  Nothing is asked while the running copy holds what its source has. The dialog,
  weighted as a local write: its title is "Update loupe to 6fa08fb", its body what will happen as itself (a short
  account of the commits in reading type, written by a model with no tools and shown as text, their first subject
  standing in until it lands or if it never does; then the commits, as the push dialog lists them; then where they
  come from and that loupe restarts and the page comes back, your reviews kept), its footer what it does (copies the
  commit into the copy loupe runs, or fast-forwards the clone). **Update** takes exactly that commit, through the
  running copy's own `promote.sh`; while a brief, scene, file notes or an answer is being written it says so and waits
  for you. How it went is a toast once the page is back ("loupe updated to 6fa08fb.", or the failure and its log).
- **List box** (files in a dialog, commits, home lists): a fill with no rule round it (paper on home's sheet, `--floor` in a
  dialog), `--r3`, rows divided by 1 px `--rule`.
- **Mark row in the code**: one line, glyph at the code's text edge, 13 px, hover `--hover`. A draft's words sit in a well that
  starts after its glyph, on the 20 px grid; its send is the primary.
- **The + that starts a mark**: in the margin, in the empty room left of its side's line number (where a hidden mark's
  pin sits), centred in it: the room runs from the column's edge (past its rule) to the first digit of its line's number
  (in unified, the wider of the two, so it keeps its place across added and kept lines). 16 px, a small key of ink (`--ink-raised`), shown on the line's hover;
  never over a number or the diff's sign. A line whose pin is there
  keeps the pin; its number still selects it.
- **Going back** after a jump (a definition, a cited line, a search result): `[`, and a slip at the foot of the diff's
  column, bottom left, that names where it goes (`‹ Back to middleware.go:13 [`, the line left from, else the file the
  diff was on, the map or the search). It is what floats (`--float-fill`), its words a link button 8 px off their ink
  and its key a hint, each 12 px from its edge. It shows while the newest place to go back to is a jump, so not after
  `]` (which `[` undoes first), and not over the whole-file viewer, which keeps its own Back in its header. Nothing goes
  back in the top bar. The mouse's back button and `⌘[` do what `[` does while there is somewhere to go, instead of
  leaving the review.
- **A drawing** (in the map card, the map under the code and the dialog): a map is drawn as Claude laid it out where
  that fits across, its widest names on two lines where that makes it fit, and turned to read top to bottom only when
  even that does not, since a turned drawing is much the taller. A flow is a lane per part and a numbered arrow per
  step, drawn across or down, whichever of the two that fit is the shorter. Across: the parts down the left, the steps
  left to right, one column each, its number and words beside its arrow's start in the gap between two lanes (never on
  a lane's line), so it is as tall as the flow has parts; short of room its words wrap shorter (three lines at most,
  none lost), then its widest names go on two lines. Down: the parts across the top and the steps down the page, as
  tall as it has steps, at its own width (it spreads across the room only once its names were narrowed to fit). When
  no form fits, the narrowest is drawn, which scrolls the least.
- **The map under the code**: the change's drawings kept at the foot of the code column, so the map and the code are
  in view at once. A pane of the frame, as the files and the inspector are: its latch sits between theirs in the top bar
  (the bottom-panel icon, `b`), shown only when the brief has a drawing, and it is remembered in this browser across both
  layouts. It is paper, as the code column is, with a rule where it meets the code; its bar is the map card's (the
  drawings as tabs, the key, Open large) on a 36 px row with its rule. It shows the whole drawing wherever it can, so
  nothing scrolls if that can be helped: it is as tall as the drawing, up to what leaves the code 320 px, and of the
  drawing's three forms (as laid out; the same narrowed to the column; turned) it takes the one that shows the most of
  it, then the shorter. A drawing is never scaled, so what still does not fit scrolls. Its top edge, dragged (a 1 px
  `--ink-3` line under the pointer, as on the panes' sides), sets how tall it may get, never taller than its drawing; a
  double-click there gives the default back. A part clicked opens its lines above and the drawing stays; `[`
  goes back to the file that was read. The part that holds the file being read has the current fill (`--press`) and is
  kept in view, unless the pointer is on the drawing. Drawings only: a scene has one player, in the card. The back slip
  and the whole-file viewer stay in the code above it, and Mote, in his own spot, stands above it.
- **Meter**: one block of lamps per file; the gap between two blocks is empty, never a dim lamp, so a board that is all
  viewed reads all lit.
- **Chat**: in your own checkout (a local workspace) it is Claude Code or Codex at work there: it reads, edits and runs
  commands, sandboxed (no network, nothing written outside the checkout, its git directory and Go's build cache), and
  leaves commits and pushes to you. Its empty state and its box say so ("Ask about the change, or have it changed").
  A pull request's chat only answers: that checkout is loupe's copy. A mark's own conversation only answers too; Edit
  in chat on a mark (yours or a GitHub thread) opens a new chat with its lines attached and its first message written,
  not sent.
- **File note**: a caption between an unfolded file's header and diff, aligned to the code's text edge where room permits.
  14 px `--ink-2` prose, 8 px above and below, with inline code in mono and the same colour. An earlier version is
  marked in 11 px amber. New notes fade in once over 120 ms, with reduced motion shown immediately.
- **Message** (chat and marks): who (13 px 600; Claude in orange), model meta 11 px `--ink-3`, body 14 px.
- **Status**: M / A / D / R letters (11 px mono 600: amber, green, red, ink-2); the pixel check for viewed; counts as
  tabular figures.
- **Empty state**: one line in `--ink-3` 13 px, with the one action that fills it as a link button.
- **Toast**: bottom centre, `--act` background, on-act text, `--r2`, 13 px; an action in it is a ghost on the ink (under the
  pointer, a key of ink, `--ink-raised`). It casts no shadow. A
  failure carries the pixel cross in red before its words, is said as an alert, and stays 6 s; any toast waits while the
  pointer is on it and goes when clicked. A
  commit's toast flips the new commit's id in from its parent's, split-flap cells one mono character wide (`receipt.js`).
- **Motion**: background and colour 120 ms `--ease`; nothing slides except dialogs (160 ms rise) and menus (none). A
  press is 50 ms in and 140 ms out. After a write the top bar's next step turns over to the one after it in the
  odometer's roll (three steps, 200 ms).
- **Reduced motion** is asked of the system (`prefers-reduced-motion`) or of loupe itself: the view menu's Motion row and
  ⌘K ("Turn reduced motion on"), kept in this browser, followed by its other tabs, and set before the first paint as
  `data-motion="reduce"` on the page. Either one stills everything the other does, and loupe's switch cannot undo the
  system's (its row is then checked and greyed, "your system asks for it"). Code asks `reducedMotion()` and listens with
  `onMotion()` (`core.js`), never the media query alone; each `prefers-reduced-motion` block in the style sheet has its
  `:root[data-motion="reduce"]` twin beside it. Turning it on or off says so in a toast.
- **Mote's look**: he looks with his eyes, never by turning his head: his idle face with the pupils a pixel toward what he
  looks at, in eight directions, jumping at most every 120 ms and only when the direction has really changed, with a
  blink before a jump across his face. He looks at the pointer when it comes within 480 px, and at what just happened
  (the row of the file you viewed, the mark you made, the answer that landed, the stamp, the next step after a write),
  for 1.2 s; not while he is busy, with reduced motion, or in a hidden tab.
- **Sound**: off until it is turned on (⌘K), and then only as the consequence of an act: a wooden tick per file viewed,
  pitched up a pentatonic ladder by the share read (the last file resolves it), a stamp, a typebar for a commit, a
  plucked string for a push, a dull knock for a failed send, one bell for an answer that lands in a hidden tab. Nothing
  for typing, clicks or scrolling. Made in the page (`voices.js`), no files.

- **Mote away**: double-click him, or Hide Mote (⌘K, the view menu): his green and red shell halves open as wings,
  with the hind wings buzzing beneath, and he flies out of the window. Show Mote flies him back to his spot.
  Remembered in the browser, and followed by its other tabs.
  Away, he is not mounted, so nothing of him runs.

- **Scene** (an animation of the change's core, in the map card's tabs, in its guide section's head, and opened large):
  a document its writer makes for that change, its own HTML, CSS and JavaScript, served by loupe at `/scene-doc` in a
  sandboxed frame (an opaque origin, no network of any kind: the policy closes the rest and the shim takes WebRTC
  away; nothing of loupe's in reach). loupe hands it material, not rules: its colour and type tokens as CSS variables,
  the plate engine (`web/js/scene-kit.js`) as an optional global, and `loupe.open('file.go:120')`, which opens a line of
  the change (from the large view: it closes, and Back opens it again). Under the frame: the scene's why (13 px). What
  the scene shows and how it moves are its writer's, its own controls included; with reduced motion it starts still. A scene's frame hears only the system's request, so
  when only loupe was asked it waits for "Play the scene" instead (a scene that started by itself stops and waits when
  the switch turns on, and starts when it turns off; one you played keeps playing).
  Before a scene is kept loupe renders it in a headless Chrome as the card shows it (680 px wide, light and dark):
  errors, loads its frame refused, content cut off or a frame with nothing in it go back to the writer with its own
  stills, which it reads and fixes (`src/scene-render.mjs`). A scene that stops answering for eight seconds is stopped
  ("Run it again"), and one flooding the page with messages too; its frame is made only near the view and let go a
  while after it leaves or the tab hides. A scene runs only where its no-connections header is kept (Chromium 152 on),
  so nothing its script adds can reach out; elsewhere the card says it plays in Chrome 152 or later, and loupe's own
  render check needs that Chrome too. It starts by itself on desktop Chromium without a touch screen, which runs a
  sandboxed frame in a process of its own, so the stop works; on a phone, a tablet or a touch screen it waits for
  "Play the scene". (The page cannot tell when a reader has turned either off in their own Chromium, the header with
  a flag or site isolation; a scene could then reach out, or, stuck in a loop, freeze the page. loupe's render Chrome
  is its own, started with a fresh profile and its own flags.) The brief decides whether
  a change needs one (most do not) and says why in a line; a second run writes it, with the model and effort the guide was written with, handed the diff of what it shows so it draws instead of reading file by file; its look-over answers with edits, never the whole document. No run that uses a model is cut off for time (the guide, a scene, file notes, a draft): what it has spent would be thrown away; a stop button or a newer guide still ends one. While it is written the card's tabs
  say so ("Drawing the scene · reading …").
- **Made in chat**: a part of the guide a chat added or changed says so in 11 px `--ink-3` (`made in chat`) where its
  label is (a section's head line, a scene's caption). The Overview's brief lists the edits ("Changed in chat"), newest
  first, each with Undo; a chat's edit also lands with a toast whose action is Undo. Regenerate keeps what chats added;
  when it would drop a chat's edits to the brief's own parts it asks in its own place first ("Regenerate, dropping a
  chat edit?" on the faint red, 3 s).

## Easter eggs
Small things for whoever plays, and only things from loupe's own world: Mote being a beetle. Each
is found by doing something a person might do anyway, never by a code; none fires during work (a dialog, an answer
being written), none makes a sound, and with reduced motion none happens. They are not in the README.
- Throw Mote (let go of him mid-swing, faster than 1.4 px/ms): he flies on, skids, lands on his back with his legs at
  the air, rocks, and heaves himself over with a hop.

## Plates
Dither in loupe is a plate: a print of a real, tonal subject in a few inks, with paper between the dots. It is never
laid over something to dim it and never part of a control. The method is the one on lolwierd.com's sky, and the engine
is `web/js/plate.js` (its pure part, `plate-core.js`, loads on its own in a scene's frame).
- **What a plate is made of**: an 8×8 ordered screen for air and edges; Atkinson error diffusion into three inks plus
  paper for mass, so a body has depth and grain and not a cutout's one tone; ink ramps per theme (`RAMPS`), neutral in
  loupe's own ink; organic variation from seeded noise. One dot is 1 CSS px, snapped to whole device pixels: the size of
  a pixel in Mote and the spark.
- **The plate of the page**: opening a dialog prints the app behind it from its own pixels (an SVG filter: luminance,
  the screen, an uneven air seeded by the change, four tones, the ramp). The page's words land in the middle ink, so
  they sit back in the print and no screen is laid over them (the scrim adds only a faint flat wash, which is all that
  sets the page back in a browser where the filter is not checked). Its exposure is as heavy as the write is hard to undo:
  the keys and the map opened large at the lightest, a local write, a public one, and a write that cannot be undone,
  which also prints in red (`sheets.js` sets `data-weight`); when overlays stack, the one on top decides. The palette is the top bar opened: the bar stays lit, so
  it pulls no plate and the page under it only steps back under a flat wash. The dialog is paper with a rule.
- **Where a plate may be**: behind a dialog; in a scene, as its subject (the labels stay type); and in the pauses that
  have a texture of their own, below. Nowhere else: not under a button, a menu or a card.
- **Motion**: nothing in a plate moves. A plate comes up dot by dot in the screen's own order (180 ms, eased) and then
  holds still while someone writes in front of it. A plate that is the subject of a scene may breathe: a slow noise
  nudges the threshold, so only cells already near it are re-decided and the shape never shifts. With reduced motion a
  plate is simply there.
- **Ink**: the page's own. Red only for a write that cannot be undone. Blue and orange keep their one job.

## Print textures
A few pauses are drawn as a print shop would show them instead of in flat colour (screens in `web/js/dither.js`).
They came before the plates, are drawn from the change's own state, and stay as they are.
- **Where**: only where nothing is being read. The opening state (the forme), the state of a change that could not
  open (the moiré), and the desk under Mote (the lens's light). Never behind code or prose, with two exceptions: Mote
  floats over the diff's bottom-right corner, so his light, no wider than his feet, can land on the end of a line (drag
  him off it); and the approval's stamp is pressed over the diff for 1.7 s, its ink multiplied into the page so the
  code stays legible through it. The stamp leaves its impression on the pull request in the inspector, a row of its own.
- **What draws them**: the change's own state, never a picture. The forme has one dot per changed line (past 2,560 a
  dot stands for several), as GitHub counts them before the fetch; the daemon sends the counts on its progress lines.
  The moiré's two screens are turned by the base's and the head's names. The lens's spot gathers as the share of lines
  left falls. The stamp prints the head you approved and the day, seeded by that head (the same head always prints the
  same stamp); its impression slips out of register when the head moves on.
- **Screens**: the 4×4 Bayer matrix (one cell to a device pixel, or to an art pixel on Mote's grid), hairline line
  screens, and letterpress dots. Every one is drawn at device pixels, never scaled or smoothed. The top bar's meter
  (one block of lamps per file) and the theme's wave use the same matrix.
- **Ink**: the page's own (`--ink`, `--ink-3`, `--hi` for light). Amber only for the impression's second plate, when
  the head has moved past your approval (changed since). Blue and orange keep their one job: no texture uses them.
- **Motion**: eased, at the display's rate. With reduced motion each is the still that says the same thing.

## Model-written text
The map, the guide's heads and the TLDR are prose a person reads. Code in them is the mono face in the text's own
colour, no chip; a place is shown as `file.go:123` with the full path on hover. Chat answers keep chips.
