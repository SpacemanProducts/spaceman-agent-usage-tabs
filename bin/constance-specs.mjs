// Constance job spec templates: the prompt skeletons for delegated work, so a
// spec is filled in rather than written freehand. guessKind picks a template
// from free text; fillSpec renders it and refuses anything missing or over-long.
// Pure functions only — no fs, no clock, no exec.
export const MAX_SPEC_CHARS = 1200;

// One short string per kind. {what} is the task, {files} where it lives,
// {accept} the acceptance criteria, {notes} anything extra. Every template ends
// with the fixed "Done when:" line so a spec always says how it is judged.
export const TEMPLATES = {
  feature: "Add {what}.\n\nFiles: {files}\nNotes: {notes}\nDone when: {accept}",
  test: "Write tests for {what}.\n\nFiles: {files}\nNotes: {notes}\nDone when: {accept}",
  bugfix: "Fix {what}.\n\nFiles: {files}\nNotes: {notes}\nDone when: {accept}",
  refactor: "Refactor {what} without changing behaviour.\n\nFiles: {files}\nNotes: {notes}\nDone when: {accept}",
  docs: "Document {what}.\n\nFiles: {files}\nNotes: {notes}\nDone when: {accept}",
};

const KINDS = Object.keys(TEMPLATES);
const REQUIRED = ["what", "accept"];
const OPTIONAL = ["files", "notes"];

// Fields are single-line: a newline (with any whitespace around it) folds to
// one space so a field can't inject extra "Done when:"/"Files:" lines.
const oneLine = (s) => s.replace(/\s*\n\s*/g, " ");
const text = (v) => {
  if (Array.isArray(v)) return v.map((x) => oneLine(String(x).trim())).filter(Boolean).join(", ");
  return v === undefined || v === null ? "" : oneLine(String(v).trim());
};

// Guess a spec kind from free text (the goal or a backlog line). First keyword
// family wins, in the order test, fix/bug, refactor, doc; anything else is a
// feature.
export function guessKind(text_) {
  const t = String(text_ || "").toLowerCase();
  if (/\btests?\b|\btesting\b|\bspec(s)?\b/.test(t)) return "test";
  if (/\bfix(es|ed|ing)?\b|\bbug(s)?\b|\bbroken\b|\bregression\b/.test(t)) return "bugfix";
  if (/\brefactor(s|ed|ing)?\b|\brename[sd]?\b|\brestructure[sd]?\b|\bclean ?up\b/.test(t)) return "refactor";
  if (/\bdocs?\b|\bdocument(ation|s|ed|ing)?\b|\breadme\b/.test(t)) return "docs";
  return "feature";
}

// Render a spec for `kind`. `fields` needs what + accept; files (string or
// array) and notes are optional — empty optional lines are dropped. Throws on
// an unknown kind, a missing required field, or a result that isn't under
// MAX_SPEC_CHARS.
export function fillSpec(kind, fields = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown spec kind: ${kind}`);
  const f = {};
  for (const k of [...REQUIRED, ...OPTIONAL]) f[k] = text(fields[k]);
  for (const k of REQUIRED) {
    if (!f[k]) throw new Error(`spec ${kind} needs a ${k}`);
  }
  const out = TEMPLATES[kind]
    .replace(/\{(what|files|accept|notes)\}/g, (m, k) => f[k])
    .split("\n")
    .filter((line) => !/^(Files|Notes):\s*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (out.length >= MAX_SPEC_CHARS) {
    throw new Error(`spec too long: ${out.length} chars (max ${MAX_SPEC_CHARS - 1})`);
  }
  return out;
}
