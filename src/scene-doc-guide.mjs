// What a model is told when it makes a scene as a document: almost nothing but the frame it runs in. The animation is
// its own (HTML, CSS and JavaScript); loupe hands over its colours, type and plate engine as material, and a way to
// open the code.
export const DOC_FRAME = `The frame your document runs in:
- It is the body of a page, in a sandboxed frame in loupe: your HTML, <style> and <script> go in as they are. It is
  640 to 1000 CSS px wide (the map card is about 680; Open large shows it at about 1000) and as tall as you ask.
- No network: everything inline (no external scripts, fonts or images; data: URIs are fine). No storage, no popups.
- loupe's look, as material: on :root, its colours (--bg the face of a part, --chrome the floor of what lies outside
  the repository, --ink, --ink-2, --ink-3, --rule, --rule-strong, --on-act for type on solid ink, --ok, --warn,
  --danger, --pencil for links), the solid line under a raised key (--shade; in dark, --lit is the line of light on its
  top) and type (--f-ui, --f-mono);
  html[data-theme] is light or dark. The background is transparent: the page shows through. LoupeSceneKit (already loaded) is the engine loupe draws its
  prints with on a canvas: LoupeSceneKit.makeKit(canvas, { colors: loupe.colors(), dark: loupe.dark, fonts:
  loupe.fonts(), dpr: devicePixelRatio, beats: [] }) returns L, and after L.size(w, h): L.plate(w, h, field) diffuses a
  tonal field into three inks once, L.print(x, y, w, h, cell) prints cells at device pixels, L.bayer(x, y) and
  L.breathe(seed, t) are the ordered screen and its breathing threshold, L.fbm(x, y, seed) is smooth noise, L.inks() the
  inks, L.text and L.hair type and rules. Use it, or none of it.
- loupe.open('path/to/file.go:120') opens that line of the change in loupe: use it for links from the animation to the code.
- It may have its own controls (play, step, scenarios to switch between) if they help. If the reader prefers reduced
  motion (the media query works here), start still and move only when asked.`;

// loupe's look, as it is: a description to draw toward, not a rule book
export const DOC_LOOK = `Make it look like loupe's own map drew it. The ground is the page showing through: never paint it. A part
(a process, a goroutine, a record, a queue) is a small plate of --bg with a 4 px radius and a one-pixel rule in
--rule-strong, its name in --f-ui 13 px, weight 500, --ink-2; the part the moment is about takes an ink rule (--ink-2)
with its name in --ink. Something outside the repository is a floor instead: --chrome, with no rule. Nothing casts a
shadow, blurs or glows: no filter, no shadow with a blur. Names from the code and numbers are --f-mono
11 to 12 px in --ink-3; rules are one pixel in --rule or --rule-strong. Ink is for type and thin marks (a line 1.5 px
wide, a dot, a tick, a short bar no taller than a line of text), never for large filled areas: a span of time or a
quantity is a hairline or a light --rule-strong fill, with ink only for what is happening now. Colours keep their jobs:
--danger only for what fails or is refused, --warn for a wait that has run out, --ok for passing, --pencil only for
links to the code. No cards or boxes round labels, no gradients or glow, no bordered buttons: a control is quiet
--ink-3 type, the chosen one in --ink, and the controls sit with the caption under the drawing, never as a row of tabs
along the top (loupe's own tabs are just above the frame). Generous, calm, exact; nothing overlaps or is cut off.`;

export const DOC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Two to five words: what the animation shows (it is a tab\'s name).' },
    why: { type: 'string', description: 'One sentence: what in this change happens over time that a map and words cannot show.' },
    section: { type: 'integer', description: 'The 1-based guide section it explains, or 0 for the change as a whole.' },
    height: { type: 'integer', description: 'The frame\'s height in CSS px, 200 to 600.' },
    html: { type: 'string', description: 'The document: HTML, with its <style> and <script>.' },
  },
  required: ['title', 'why', 'section', 'height', 'html'],
};

// what a look-over answers: right as it is, or the few edits that fix it (never the whole document again)
export const LOOK_SCHEMA = {
  type: 'object',
  properties: {
    right: { type: 'boolean', description: 'true when it renders, reads and looks right as it is (then give no edits).' },
    edits: { type: 'array', description: 'The fixes, applied in order: each find is an exact passage of the document that is there once.', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] } },
    height: { type: ['integer', 'null'], description: 'A new frame height in CSS px, 200 to 600, only if the frame should change; otherwise null.' },
  },
  required: ['right', 'edits'],
};

export function docPrompt({ change, story = '', diff = '' }) {
  return `Make an animation that explains the core of this code change to a reviewer. It is shown in loupe, a local
code-review desk, under the change's map.

${change}
${story ? `\nWhat it should show (from the change's guide):\n${story}\n` : ''}
It must be exact to what the code does. ${diff ? `The diff of the files it is about is below; read a file of the change
only for something you need that is not in it (every read keeps the reader waiting).

\`\`\`diff
${diff}
\`\`\`` : 'Read the code first.'} Then make it however you like.

${DOC_FRAME}

${DOC_LOOK}

loupe renders it before keeping it (in light and dark, at the card's width) and shows you the frames, so you can
check that it renders, reads and looks right.

Answer through the structured output.`;
}
