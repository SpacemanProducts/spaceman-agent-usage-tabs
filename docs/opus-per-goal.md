# Opus per goal: one long session vs. a fresh session per step

Measured 2026-11-26 with `bin/constance-opus-bench.mjs` (raw lines: `docs/opus-bench.jsonl`).

- **Before:** constance-next at `a98deb6`. One Claude Code session per goal; she delegates, then loops
  `C wait` → review in the same session until nothing is open.
- **After:** 1.55.0 (the final rows in the log; the first planning step also carries the owner's goal verbatim). The driver waits, and each planning step and each review batch is a fresh session
  that reads `.constance/handoff.md`, her lessons and the batch's job reports.

The goal is the same fake goal both times: N numbered items, one fake Devin copy per item, finishing a
little apart. The fake `claude` acts only on its prompt. Both modes do the same work: one `C agents` check
per planning pass, one delegate per item (a refused one is tried again later), one review per job. Every job
was accepted, and the turn counts match.

| Items | Mode | Brain runs | Sessions | Turns | Input tokens | Largest context | Output tokens |
|---:|---|---:|---:|---:|---:|---:|---:|
| 3 | before | 1 | 1 | 12 | 36,247 | 4,161 | 535 |
| 3 | after | 2 (plan, review) | 2 | 12 | 34,302 (−5%) | 3,063 (−26%) | 521 |
| 6 | before | 1 | 1 | 21 | 94,343 | 7,771 | 971 |
| 6 | after | 3 (plan, review ×2) | 3 | 20 | 59,921 (−36%) | 3,413 (−56%) | 892 |
| 12 | before | 1 | 1 | 44 | 286,690 | 13,626 | 2,099 |
| 12 | after | 7 (plan ×2, review ×5) | 7 | 44 | 136,819 (−52%) | 4,110 (−70%) | 1,962 |

**How it is counted.** Tokens are characters / 4. A session's context is her role (system prompt), the
prompt, and every tool call and tool output so far. Each turn (one model call) re-reads all of it, so
input tokens are the sum over turns. In the old mode that sum grows with the square of the goal's size.
In step mode each session starts from the short handoff file, so the largest context stays about flat.

**What it leaves out, so read the percentages as an upper bound on the real limit saving:**
- Claude Code's own system prompt and tool definitions: a fixed cost on every turn. The turn counts
  are equal, so this adds the same amount to both columns and shrinks the percentages.
- Prompt caching: a long session's re-reads are mostly cache hits, which real limits count at a
  discount. A fresh session pays full price for its first read of the role and the handoff.
- Real sessions read more than this fake does (diffs, files, `C status`). The old mode kept all of it
  until the goal ended; a step drops it when it exits. On real goals the context saving should be
  larger than shown here.

Rerun: `node bin/constance-opus-bench.mjs --items 6 [--cli <old checkout>/bin/constance.mjs] --label TEXT --log docs/opus-bench.jsonl`
(always a mktemp fake home; nothing real is touched).
