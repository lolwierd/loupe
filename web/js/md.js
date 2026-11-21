// Markdown the way GitHub renders it, for PR descriptions, GitHub comments, Claude's answers and hover cards.
// marked parses (GFM: tables, task lists, strikethrough). Then, as GitHub does: HTML comments are dropped, the safe
// subset of HTML stays (details, img, kbd, sub, tables, line breaks…) and everything else is stripped, :emoji: codes
// become emoji, > [!NOTE] and its kin become callouts, @people and #123 link to GitHub. Links go out only over
// http(s), and path:line turns into a link that opens the place in the diff.
import { Marked } from '/vendor/marked.js';
import { esc, S } from './core.js';

const LOC = /(?<![\w/.-])((?:[\w.@-]+\/)*[\w.@-]+\.(?:go|mod|sum|tmpl|tpl|sql|ya?ml|json|md|j2|[cm]?js|jsx|[cm]?ts|tsx|py|rb|rs|hcl|tf|sh|toml|proto|css|html|swift|kt|java|c|h|cc|cpp|lua|nix|service|conf|ini))(?::(\d+)(?:[-–](\d+))?)?(?![\w])/g;
// a place is shown by its file name and line (the full path is in its title): a paragraph of refs stays short, and the
// click still opens the exact file
const locLink = (m, p, a, excerpt) => `<a class="loc" role="link" tabindex="0" data-p="${esc(p)}" data-l="${a}"${excerpt ? ` data-excerpt="${esc(excerpt)}"` : ''} title="${m}">${m.slice(p.lastIndexOf('/') + 1)}</a>`; // m is already HTML text
const linkify = (html) => html.replace(LOC, (m, p, a) => (a ? locLink(m, p, a) : m));

const mk = new Marked({ gfm: true, breaks: false });
mk.use({
  renderer: {
    // raw HTML goes through to the sanitizer below, which keeps only what GitHub would
    html({ text }) { return text; },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!/^https?:\/\//i.test(href || '')) return inner;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}>${inner}</a>`;
    },
    image({ href, text, title }) {
      if (!/^https:\/\//i.test(href || '')) return esc(text || '');
      return `<img src="${esc(href)}" alt="${esc(text || '')}"${title ? ` title="${esc(title)}"` : ''}>`;
    },
    code({ text, lang }) {
      return `<pre><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${linkify(esc(text))}</code></pre>`;
    },
  },
});

// ------------------------------------------------------------------ the HTML GitHub keeps
const KEEP = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'picture', 'pre', 'q', 's', 'samp', 'source', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var']);
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'svg', 'math', 'template', 'noscript', 'textarea', 'select', 'button', 'video', 'audio']);
const ATTRS = { a: ['href', 'title', 'class', 'data-p', 'data-l'], img: ['src', 'alt', 'title', 'width', 'height'], source: ['srcset', 'media'], details: ['open'], td: ['align', 'colspan', 'rowspan'], th: ['align', 'colspan', 'rowspan'], input: ['type', 'checked', 'disabled'], code: ['data-lang'], ol: ['start'], div: ['align'], p: ['align'], span: [] };
function clean(html, images) {
  const t = document.createElement('template');
  t.innerHTML = html;
  for (const c of t.content.querySelectorAll('*')) void c; // (parse once)
  const walk = (parent) => {
    for (const el of [...parent.children]) {
      const tag = el.tagName.toLowerCase();
      if (!images && tag === 'img') { el.replaceWith(document.createTextNode(el.getAttribute('alt') || '')); continue; }
      if (!images && tag === 'source') { el.remove(); continue; }
      if (DROP.has(tag)) { el.remove(); continue; }
      if (!KEEP.has(tag)) { walk(el); el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) if (!(ATTRS[tag] || []).includes(a.name)) el.removeAttribute(a.name);
      if (tag === 'a') { const h = el.getAttribute('href') || ''; if (h && !/^https?:\/\//i.test(h)) el.removeAttribute('href'); if (el.hasAttribute('href')) { el.target = '_blank'; el.rel = 'noopener noreferrer'; } }
      if (tag === 'img') { if (!/^https:\/\//i.test(el.getAttribute('src') || '')) { el.replaceWith(document.createTextNode(el.getAttribute('alt') || '')); continue; } el.loading = 'lazy'; el.referrerPolicy = 'no-referrer'; }
      if (tag === 'source' && !/^https:\/\//i.test(el.getAttribute('srcset') || '')) { el.remove(); continue; }
      if (tag === 'input') { if (el.getAttribute('type') !== 'checkbox') { el.remove(); continue; } el.disabled = true; }
      walk(el);
    }
  };
  walk(t.content);
  return t.innerHTML;
}

// ------------------------------------------------------------------ :emoji:, callouts, @people, #123
const EMOJI = {
  white_check_mark: '✅', heavy_check_mark: '✔️', check: '✔️', x: '❌', heavy_multiplication_x: '✖️', negative_squared_cross_mark: '❎', warning: '⚠️', no_entry: '⛔', no_entry_sign: '🚫',
  rotating_light: '🚨', exclamation: '❗', question: '❓', grey_question: '❔', bulb: '💡', memo: '📝', pencil: '📝', pencil2: '✏️', book: '📖', books: '📚', link: '🔗', lock: '🔒', unlock: '🔓', key: '🔑',
  rocket: '🚀', tada: '🎉', sparkles: '✨', fire: '🔥', boom: '💥', zap: '⚡', star: '⭐', star2: '🌟', bug: '🐛', beetle: '🐞', wrench: '🔧', hammer: '🔨', hammer_and_wrench: '🛠️', gear: '⚙️', toolbox: '🧰',
  construction: '🚧', recycle: '♻️', package: '📦', truck: '🚚', art: '🎨', lipstick: '💄', wastebasket: '🗑️', fire_engine: '🚒', ambulance: '🚑', adhesive_bandage: '🩹', test_tube: '🧪', microscope: '🔬',
  chart_with_upwards_trend: '📈', chart_with_downwards_trend: '📉', bar_chart: '📊', mag: '🔍', mag_right: '🔎', eyes: '👀', thinking: '🤔', thinking_face: '🤔', smile: '😄', smiley: '😃', grin: '😁', joy: '😂',
  wink: '😉', slightly_smiling_face: '🙂', upside_down_face: '🙃', sweat_smile: '😅', sob: '😭', cry: '😢', confused: '😕', scream: '😱', heart: '❤️', green_heart: '💚', blue_heart: '💙', yellow_heart: '💛',
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', clap: '👏', pray: '🙏', raised_hands: '🙌', wave: '👋', muscle: '💪', ok_hand: '👌', point_right: '👉', point_left: '👈', point_up: '☝️', point_down: '👇',
  arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️', arrow_forward: '▶️', leftwards_arrow_with_hook: '↩️', heavy_plus_sign: '➕', heavy_minus_sign: '➖', information_source: 'ℹ️', new: '🆕',
  hourglass: '⌛', hourglass_flowing_sand: '⏳', stopwatch: '⏱️', alarm_clock: '⏰', calendar: '📅', date: '📅', pushpin: '📌', round_pushpin: '📍', paperclip: '📎', scissors: '✂️', label: '🏷️', bookmark: '🔖',
  speech_balloon: '💬', thought_balloon: '💭', loudspeaker: '📢', mega: '📣', bell: '🔔', no_bell: '🔕', robot: '🤖', ghost: '👻', skull: '💀', shield: '🛡️', crossed_swords: '⚔️', dart: '🎯', trophy: '🏆',
  green_circle: '🟢', red_circle: '🔴', yellow_circle: '🟡', orange_circle: '🟠', blue_circle: '🔵', white_circle: '⚪', black_circle: '⚫', large_blue_circle: '🔵', small_red_triangle: '🔺', small_red_triangle_down: '🔻',
  arrows_counterclockwise: '🔄', repeat: '🔁', twisted_rightwards_arrows: '🔀', globe_with_meridians: '🌐', earth_americas: '🌎', cloud: '☁️', sunny: '☀️', snowflake: '❄️', droplet: '💧', ocean: '🌊', seedling: '🌱',
  coffee: '☕', pizza: '🍕', beer: '🍺', computer: '💻', desktop_computer: '🖥️', keyboard: '⌨️', floppy_disk: '💾', cd: '💿', dvd: '📀', file_folder: '📁', open_file_folder: '📂', page_facing_up: '📄', clipboard: '📋',
  goal_net: '🥅', building_construction: '🏗️', card_file_box: '🗃️', alembic: '⚗️', passport_control: '🛂', bricks: '🧱', monocle_face: '🧐', technologist: '🧑‍💻', busts_in_silhouette: '👥', bust_in_silhouette: '👤',
};
const ALERTS = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };
function textOutsideCode(html, fn) {
  // apply fn to text between tags, skipping <code>…</code>, <pre>…</pre> and <a>…</a>
  return html.split(/(<pre[\s>][\s\S]*?<\/pre>|<code[\s>][\s\S]*?<\/code>|<a [^>]*>[\s\S]*?<\/a>)/).map((part, i) => (i % 2 ? part : part.replace(/>([^<]+)</g, (m, t) => '>' + fn(t) + '<'))).join('');
}
function github(html) {
  html = html.replace(/<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br>)?/g, (m, k) => `<blockquote class="alert ${k.toLowerCase()}"><p class="alert-t">${ALERTS[k]}</p><p>`);
  html = html.replace(/<p>\s*<\/p>/g, '');
  const repo = S.github?.repoFull || S.ws?.repoFull || null;
  return textOutsideCode(`<div>${html}</div>`, (t) => t
    .replace(/:([a-z0-9_+-]+):/g, (m, k) => EMOJI[k] || m)
    .replace(/(^|[\s(])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w-])/g, (m, pre, u) => `${pre}<a href="https://github.com/${u}" target="_blank" rel="noopener noreferrer" class="mention">@${u}</a>`)
    .replace(/(^|[\s(])#(\d{1,6})\b/g, (m, pre, n) => (repo ? `${pre}<a href="https://github.com/${repo}/pull/${n}" target="_blank" rel="noopener noreferrer" class="issue">#${n}</a>` : m)))
    .replace(/^<div>|<\/div>$/g, '');
}

export function md(src, { links = true, images = true, citations = {} } = {}) {
  let html;
  const text = String(src || '').replace(/<!--[\s\S]*?-->/g, '');
  try { html = github(clean(mk.parse(text), images)); } catch { html = `<p>${esc(text)}</p>`; }
  if (!links) return html;
  // Linkify text outside of <pre> (code blocks are linkified above), including inline code.
  return html.split(/(<pre>[\s\S]*?<\/pre>|<a [^>]*>[\s\S]*?<\/a>)/).map((part, i) => (i % 2 ? part : part.replace(/>([^<]+)</g, (m, t) => '>' + t.replace(LOC, (mm, p, a) => (a ? locLink(mm, p, a, citations[`${p}:${a}`]) : mm)) + '<'))).join('');
}
