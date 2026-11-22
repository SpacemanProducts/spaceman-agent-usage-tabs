#!/usr/bin/env node
// The panel's handoff question: `handoff-answer.mjs allow` writes the waiting note, `dismiss` forgets it.
import os from "node:os";
import path from "node:path";
import { answerPending } from "./handoff.mjs";
const dir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "omarchy", "agent-usage-tabs");
const action = process.argv[2] === "allow" ? "allow" : "dismiss";
const written = answerPending(path.join(dir, "handoff-pending.json"), action);
if (written) console.log(written);
