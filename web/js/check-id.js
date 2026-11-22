// A check's tick is keyed by the brief, its section's id and the check's own words, so the tick stays with its check
// however the guide is edited, and a check whose words change starts unticked. Shared by the daemon (src/guide.mjs)
// and the page (cards.js, tree.js).
export function checkId(text) { let h = 2166136261 >>> 0; for (const c of String(text)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); }
