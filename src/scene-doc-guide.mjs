// What a model is told when it makes a scene as a document: almost nothing but the frame it runs in. The animation is
// its own (HTML, CSS and JavaScript); loupe hands over its colours, type and plate engine as material, and a way to
// open the code.
export const DOC_FRAME = `The frame your document runs in:
- It is the body of a page, in a sandboxed frame in loupe: your HTML, <style> and <script> go in as they are. It is
  640 to 1000 CSS px wide (the map card is about 680; Open large shows it at about 1000) and as tall as you ask.
- No network: everything inline (no external scripts, fonts or images; data: URIs are fine). No storage, no popups.
- loupe's look, as material: on :root, its colours (--bg the page, --ink, --ink-2, --ink-3, --rule, --rule-strong,
  --on-act for type on solid ink, --ok, --warn, --danger, --pencil for links) and type (--f-ui, --f-mono);
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
export const DOC_LOOK = `Make it look like loupe drew it. loupe is a plain ground: type in its own faces (--f-ui at 13 px for names,
--f-mono at 11 to 12 px for names from the code and numbers), rules one pixel thick in --rule or --rule-strong, and flat
ink: the things that move or are counted are solid --ink shapes with their names in --on-act or beside them, and what
describes them is in --ink-2 and --ink-3. Colours keep their jobs: --danger only for what fails or is refused, --warn
for a wait that has run out, --ok for passing, --pencil only for links to the code. It has no cards, no boxes round
every label, no shadows, gradients or glow, no bordered buttons (a control is quiet type or a small icon, the chosen
one in ink); now and then the one thing a change is about is a dithered print (LoupeSceneKit's plates). Generous,
calm, exact; nothing overlaps or is cut off.`;

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

export function docPrompt({ change, story = '' }) {
  return `Make an animation that explains the core of this code change to a reviewer. It is shown in loupe, a local
code-review desk, under the change's map.

${change}
${story ? `\nWhat it should show (from the change's guide):\n${story}\n` : ''}
Read the code first: it must be exact to what the code does. Then make it however you like.

${DOC_FRAME}

${DOC_LOOK}

loupe renders it before keeping it (in light and dark, at the card's width) and shows you the frames, so you can
check that it renders, reads and looks right.

Answer through the structured output.`;
}
