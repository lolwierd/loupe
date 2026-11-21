// Shared by the page's automatic trigger and the daemon's model input.
const excluded = /(?:^|\/)(?:vendor|third[-_]party|node_modules|__snapshots__|generated|gen|__generated__)\/|(?:\.snap|\.lock(?:b|file)?|\.min\.(?:js|css)|\.pb\.go|_pb2\.py|\.g\.dart|\.designer\.cs|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.(?:work\.)?sum|packages\.lock\.json|deno\.lock))$/i;

// Notes written by an older prompt are written again: each note is saved with the version that wrote it, and one from
// another version counts its file as unwritten (so a run cut short leaves the rest marked old). 2: the note says the file's part in the change, not what its diff shows (22 Nov 2026).
export const NOTES_VERSION = 2;
export const currentNotes = (notes) => Object.fromEntries(Object.entries(notes?.files || {}).filter(([, e]) => e?.v === NOTES_VERSION));
export const fileNoteKey = (f) => `${f.path}:${f.oldPath || ''}:${f.blob}:${f.oldBlob}`;
export const eligibleForNotes = (f, hunks) => f.kind !== 'generated' && !f.binary &&
  !excluded.test(f.path) && !(f.oldPath && excluded.test(f.oldPath)) && (f.added > 0 || f.deleted > 0) &&
  !hunks?.some((h) => h.context?.includes('\uFFFD') || h.lines.some((l) => l.s.includes('\uFFFD')));

export function filesNeedingNotes(files, notes, again = false) {
  return files.filter((f) => eligibleForNotes(f) && (again ||
    !Object.hasOwn(notes, f.path) || notes[f.path].key !== fileNoteKey(f)));
}

export async function attemptFileNotes(change, request) {
  if (change.request || change.attempted) return;
  const token = change.request = {};
  try {
    const result = await request();
    if (change.request !== token) return;
    change.attempted = result?.started === true;
    change.retryAt = result?.retryAt;
    return change.retryAt;
  } finally {
    if (change.request === token) change.request = null;
  }
}

export function resetNotesAttempt(change) {
  if (change) Object.assign(change, { attempted: false, request: null, retryAt: undefined });
}
