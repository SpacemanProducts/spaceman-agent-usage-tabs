#!/usr/bin/env node
// The fallback for the Claude Squad launcher: write the ticked agents as profiles in cs's config, so a cs version that
// offers a profile picker lists them. (cs 1.0.20 reads the list but never showed a picker in testing; the launcher does
// not depend on it.) Only profiles this plugin manages (named after an agent below) are replaced; your own are kept,
// and every other key, including default_program, is left alone.
// Usage: squad-profiles.mjs <cs-config.json> <agent-cli>...
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NAMES = {
  claude: "Claude Code", agy: "Antigravity", grok: "Grok", codex: "Codex", copilot: "Copilot", "cursor-agent": "Cursor Agent",
  opencode: "OpenCode", kimi: "Kimi", "kiro-cli": "Kiro", devin: "Devin", amp: "Amp", hermes: "Hermes",
};

export function mergeProfiles(config, clis) {
  const base = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const managed = new Set(Object.values(NAMES));
  const mine = (Array.isArray(base.profiles) ? base.profiles : []).filter((p) => !(p && managed.has(p.name)));
  const ours = clis.filter((c) => NAMES[c]).map((c) => ({ name: NAMES[c], program: c }));
  return { ...base, profiles: [...mine, ...ours] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, ...clis] = process.argv.slice(2);
  if (!file) process.exit(1);
  let current = {}; try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const next = mergeProfiles(current, clis);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
