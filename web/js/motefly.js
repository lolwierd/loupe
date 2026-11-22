// Mote's flight cels, rebuilt from the idle shell and drawn at one sheet pixel per CSS pixel.
const W = 48, H = 52, X = 24, Y = 8;
export const FLY_W = 96, FLY_H = 64, FLY_STEP = 83, FLY_TRAVEL = 11;

export const FLY_OFF = [
  'closed', 'squash', 'cracked', 'open28', 'open42', 'beatUp',
  'beatDown', 'beatUp', 'beatDown', 'beatUp', 'beatDown', 'beatUp',
  'beatDown', 'beatUp', 'beatDown', 'beatUp', 'beatDown',
];
export const FLY_BACK = [
  'beatUp', 'beatDown', 'beatUp', 'beatDown', 'beatUp', 'beatDown',
  'beatUp', 'beatDown', 'beatUp', 'beatDown', 'beatUp',
  'touchdown', 'fold42', 'fold28', 'cracked', 'closed',
];

const PALETTE = [
  [0, 0, 0, 0], [50, 30, 23, 255], [174, 179, 104, 255],
  [227, 135, 124, 255], [251, 160, 150, 255], [203, 207, 139, 255],
];
const [EMPTY, A, B, D, E, G] = PALETTE.map((_, i) => i);
const MEMBRANE = {
  a: 'rgba(128, 80, 47, .8)',
  f: 'rgba(226, 238, 226, .6)',
  // Brown at 50% composited over the membrane fill.
  v: 'rgba(165, 139, 114, .8)',
};

// Inclusive green and red shell spans in the idle cel, rows 20–44. The space between the
// spans follows the antenna roots, cheeks, arm, lens and belly. Keep those sheet pixels in place.
const RIM = [
  [21, 23, 24, 26], [17, 18, 30, 31], [15, 19, 30, 32],
  [14, 23, 24, 34], [13, 23, 24, 35], [12, 23, 24, 36],
  [11, 20, 28, 37], [11, 17, 30, 37], [10, 16, 32, 38], [10, 15, 33, 38],
  [9, 15, 33, 39], [9, 14, 34, 39], [9, 14, 34, 39], [9, 14, 34, 39],
  [9, 14, 35, 39], [9, 13, 36, 39], [9, 12, 37, 39], [9, 17, 37, 39],
  [10, 16, 37, 38], [10, 15, 37, 38], [10, 14, 36, 38], [11, 14, 35, 37],
  [11, 14, 34, 37], [12, 15, 33, 36], [13, 15, 32, 35],
];

// Continue the dome's outline where its lower edge disappears behind the belly.
const DOME_TIP = [[15, 33], [17, 31], [20, 28], [23, 24]];

// Glints along the upper outside curve, mirrored into the red case.
const CASE_LIGHT = [
  '......GGG',
  '....GGGG.',
  '..GGGG...',
  '.GGG.....',
  'GGG......',
  'GG.......',
];

// The exposed back at (13, 24), hugging the head outline and ending at the arms.
const ABDOMEN = [
  '........AAAAAAA........',
  '......AACCCCCCCAA......',
  '....AACCCCCCCCCCCAA....',
  '...ACCCCCCCCCCCCCCCA...',
  '..ACCCCCCCCCCCCCCCCCA..',
  '.ACCCCCCCCCCCCCCCCCCCA.',
  '.ACCCCCCCCCCCCCCCCCCCA.',
  'ACCCCCCCCCCCCCCCCCCCCCA',
  'ACCCCCCCCCCCCCCCCCCCCCA',
  'AAAAAAAAAAAAAAAAAAAAAAA',
  '.ACCCCCCCCCCCCCCCCCCCA.',
  '..ACCCCCCCCCCCCCCCCCA..',
  '....AAAAAAAAAAAAAAA....',
];

// Antenna roots overlap the closed shell. The tops are entirely above row 20.
const ANTENNA_ROOTS = [
  [19, 21, 26, 29],
  [19, 22, 25, 29],
  [20, 21, 27, 28],
  [20, 20, 27, 27],
];

// Right hind wing from root to tip, with a single vein. The left membrane uses the same cut.
const PEEK = [
  '........aaaa',
  '.....aaafffa',
  '...aafvfaaa.',
  'aaffvaaa....',
  '.aaa........',
];
const HALF = [
  '...........aaaaa',
  '........aaaafffa',
  '.....aaafffvffaa',
  '..aaafvvvffaaaa.',
  'aavvvfffaaa.....',
  '.aaaaaaa........',
];
// In the upstroke the case hides the midsection. The tip flicks up past its outer edge.
const UP = [
  '.......................aaa',
  '...................aaaaffa',
  '...............aaaaffffaa',
  '...........aaaaffvvvvaa',
  '.......aaaaffvvvvffaa',
  '....aaaffvvvvffaaa',
  '..aaffvvvffaaa',
  'aavvvfaaaa',
  'aaaaaa',
];
// The downstroke sweeps below the case tip, exposing the whole outer membrane.
const DOWN = [
  'aa',
  'afaa',
  'afffaaa',
  '.avvffffaa',
  '.affvvffffaaa',
  '..afffvvvffffaa',
  '...affffvvvffffaa',
  '....aafffffvvvfffaa',
  '......aaffffffvvvffaa',
  '........aaaffffffvvvfa',
  '...........aaaafffffvva',
  '...............aaaaaaaaa',
];

function surface(width, height) {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  return canvas.getContext('2d', { willReadFrequently: true });
}

function pixels(ctx, rows, x, y, colors, dx = 1) {
  rows.forEach((row, j) => [...row].forEach((ch, i) => {
    if (ch === '.') return;
    ctx.fillStyle = colors[ch];
    ctx.fillRect(x + i * dx, y + j, 1, 1);
  }));
}

function scale2x({ data, width, height }) {
  const scaled = new Uint8Array(width * height * 4);
  const stride = width * 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x, center = data[i];
      const above = y > 0 ? data[i - width] : center;
      const below = y + 1 < height ? data[i + width] : center;
      const left = x > 0 ? data[i - 1] : center;
      const right = x + 1 < width ? data[i + 1] : center;
      const corner = (a, b) => above !== below && left !== right && a === b ? a : center;
      const j = 2 * y * stride + 2 * x;
      scaled[j] = corner(above, left);
      scaled[j + 1] = corner(above, right);
      scaled[j + stride] = corner(below, left);
      scaled[j + stride + 1] = corner(below, right);
    }
  }
  return { data: scaled, width: stride, height: height * 2 };
}

function makeShell(right) {
  const data = new Uint8Array(W * H);
  const base = right ? D : B;
  const outerEdges = RIM.map(([left, , , right]) => [left, right]).concat(DOME_TIP);
  outerEdges.forEach(([leftEdge, rightEdge], row) => {
    const left = right ? 24 : leftEdge;
    const end = right ? rightEdge : 23;
    const start = (row + 20) * W;
    data.fill(base, start + left, start + end + 1);
  });
  CASE_LIGHT.forEach((row, j) => [...row].forEach((ch, i) => {
    if (ch === '.') return;
    const x = right ? 34 - i : 14 + i;
    data[(j + 22) * W + x] = right ? E : G;
  }));
  return scale2x(scale2x(scale2x({ data, width: W, height: H })));
}

function drawShell(ctx, source, right, degrees, part) {
  const angle = (right ? -degrees : degrees) * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const hingeX = right ? 25 : 24, hingeY = 22;
  const shift = right ? part : -part;
  const rotated = new Uint8Array(FLY_W * FLY_H);
  const sample = (dx, dy) => {
    const sx = Math.floor(8 * (hingeX + dx * cos + dy * sin));
    const sy = Math.floor(8 * (hingeY - dx * sin + dy * cos));
    if (sx < 0 || sx >= source.width || sy < 0 || sy >= source.height) return EMPTY;
    return source.data[sy * source.width + sx];
  };
  for (let y = 0; y < FLY_H; y++) {
    for (let x = 0; x < FLY_W; x++) {
      const dx = x + .5 - X - hingeX - shift, dy = y + .5 - Y - hingeY;
      // A majority vote keeps the rotating edges solid while retaining the sheet palette.
      const edges = [sample(dx - .25, dy - .25), sample(dx + .25, dy - .25),
        sample(dx - .25, dy + .25), sample(dx + .25, dy + .25)].filter(Boolean);
      const center = sample(dx, dy);
      if (edges.length > 2 || (edges.length === 2 && center)) {
        rotated[y * FLY_W + x] = center || edges[0];
      }
    }
  }
  const layer = ctx.createImageData(FLY_W, FLY_H);
  for (let y = 0; y < FLY_H; y++) {
    for (let x = 0; x < FLY_W; x++) {
      const i = y * FLY_W + x, color = rotated[i];
      if (color === EMPTY) continue;
      // Re-ink the perimeter at 1×, including the straight edge along the seam.
      const edge = x === 0 || x === FLY_W - 1 || !rotated[i - 1] || !rotated[i + 1] ||
        !rotated[i - FLY_W] || !rotated[i + FLY_W];
      layer.data.set(PALETTE[edge ? A : color], i * 4);
    }
  }
  const wing = surface(FLY_W, FLY_H);
  wing.putImageData(layer, 0, 0);
  ctx.drawImage(wing.canvas, 0, 0);
}

export function makeFlightFrames(sheet) {
  const body = surface(W, H);
  const cel = surface(FLY_W, FLY_H);
  const idle = () => body.drawImage(sheet, 0, 0, W, H, 0, 0, W, H);

  const frames = {};
  const save = (key) => { frames[key] = cel.canvas.toDataURL('image/png'); cel.clearRect(0, 0, FLY_W, FLY_H); };
  idle();
  cel.drawImage(body.canvas, X, Y);
  save('closed');
  // Drop everything above the soles by one pixel. Keep the feet on the same baseline.
  cel.drawImage(body.canvas, 0, 0, W, 49, X, Y + 1, W, 49);
  cel.drawImage(body.canvas, 0, 49, W, 1, X, Y + 49, W, 1);
  save('squash');

  const left = makeShell(false), right = makeShell(true);
  const antennae = surface(W, H);
  antennae.drawImage(body.canvas, 0, 0, W, 20, 0, 0, W, 20);
  ANTENNA_ROOTS.forEach(([leftStart, leftEnd, rightStart, rightEnd], row) => {
    const y = row + 20;
    for (const [start, end] of [[leftStart, leftEnd], [rightStart, rightEnd]]) {
      const width = end - start + 1;
      antennae.drawImage(body.canvas, start, y, width, 1, start, y, width, 1);
    }
  });
  const foreground = surface(W, H);
  foreground.drawImage(body.canvas, 0, 24, W, 22, 0, 24, W, 22);
  RIM.slice(4).forEach(([leftStart, leftEnd, rightStart, rightEnd], row) => {
    foreground.clearRect(leftStart, row + 24, leftEnd - leftStart + 1, 1);
    foreground.clearRect(rightStart, row + 24, rightEnd - rightStart + 1, 1);
  });
  foreground.clearRect(0, 44, 18, 2);
  foreground.clearRect(31, 44, W - 31, 2);

  // The feet are the bottom of jumping row 4, col 2, shifted back under the idle belly.
  const feet = surface(W, H);
  feet.drawImage(sheet, 2 * W + 13, 4 * H + 36, 5, 5, 14, 44, 5, 5);
  feet.drawImage(sheet, 2 * W + 28, 4 * H + 36, 6, 5, 28, 44, 6, 5);

  const colors = { A: 'rgb(50, 30, 23)', C: 'rgb(128, 80, 47)' };
  for (const [key, degrees, part, membrane, y, bump = 0] of [
    ['cracked', 12, 1], ['open28', 28, 2, PEEK, 35], ['open42', 42, 3, HALF, 35],
    ['beatUp', 42, 3, UP, 31], ['beatDown', 42, 3, DOWN, 36],
    ['touchdown', 42, 3, DOWN, 36, 1], ['fold42', 42, 3, HALF, 35], ['fold28', 28, 2],
  ]) {
    cel.save();
    cel.translate(0, bump);
    if (membrane) {
      pixels(cel, membrane, X + 29, Y + y, MEMBRANE);
      pixels(cel, membrane, X + 19, Y + y, MEMBRANE, -1);
    }
    drawShell(cel, left, false, degrees, part);
    drawShell(cel, right, true, degrees, part);
    pixels(cel, ABDOMEN, X + 13, Y + 24, colors);
    cel.drawImage(feet.canvas, X, Y);
    cel.drawImage(foreground.canvas, X, Y);
    cel.drawImage(antennae.canvas, X, Y);
    cel.restore();
    save(key);
  }
  return frames;
}
