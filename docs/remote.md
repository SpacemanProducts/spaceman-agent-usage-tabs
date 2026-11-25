# Remote status and goals — proposal (not enabled)

Goal: check Constance's status and add goals from a phone, **without opening
any listening port on this machine**. Builds on `docs/remote-control.md`
(two-step plan) and `bin/constance-remote.mjs` (`remoteSummary()` /
`writeRemoteStatus()`, which already produce a phone-safe `remote-status.txt`).

**Nothing here is enabled.** Any channel needs the owner's OK first, same as
remote-control.md.

## What already exists

- `node bin/constance.mjs remote` writes `remote-status.txt` into Constance's
  state dir: goal line, checklist ticks, job counts, Session/Weekly %, practice
  flag — every string stripped of paths and emails. Written tmp+rename so a
  reader never sees half a file. Rewritten on the status refresh cadence.
- Goal entry point is `C goals add --goal T --dir D` → the goal queue
  (`bin/constance-goalqueue.mjs`), which already applies pacing, practice-mode
  and `needsOwner()` checks before anything runs.
- `needs-you` log lines + `notify-send` already reach the desktop; that is the
  natural surface for owner confirmation.

What is missing (all future work, none of it in this doc's scope):

- a goal **inbox**: a watched folder where a phone drops one small text file;
- a watcher that turns an inbox file into a *pending* goal awaiting owner
  approval on the desktop, then runs `C goals add` only after approval;
- a transport for both files (the options below).

## The owner-confirmation gate (same for every option)

A file arriving from a phone is **never executed or queued directly**:

1. Watcher notices a complete small file in `goal-inbox/` (cap ~4 KB, plain
   text, first lines only; ignores `*.tmp`, dotfiles, oversized files).
2. It stages the text as a *pending* goal and notifies the desktop
   (`needs-you` + notify-send + panel card): "Goal from phone: <first line> —
   approve?"
3. Only the owner's approval on the desktop (panel button or
   `C goals approve`) turns it into `C goals add`. Decline or timeout drops it.
4. From there it is an ordinary queued goal: practice mode, pace, limits and
   `needsOwner()` decide exactly as for a goal typed at the keyboard.

This keeps one rule: **the phone can propose, only the desktop can commit.**

## Options (no new listening port on this machine)

### A. Folder synced by a tool the owner already runs

If the owner already syncs a folder between PC and phone (Syncthing, Dropbox,
Nextcloud, a git-synced folder, …), put `remote-status.txt` and
`goal-inbox/` inside it. The sync tool's own ports are already open for other
reasons; this adds nothing.

- **Exposes:** the sanitized status file (goal text, checklist, job counts,
  limit %s) to the sync service; raw goal text written from the phone is also
  visible to that service while in flight.
- **Goal check:** same gate above; watcher sees the file appear.
- **Threats:** the sync account becomes a trust boundary — anyone with it can
  read status and *write* goal files (mitigated by owner approval, but a
  compromised sync account can spam pending goals). Sync conflicts can produce
  partial files (atomic-rename convention already helps; inbox should require
  a complete file). Goal text is unsanitized free text — it becomes agent
  instructions.
- **Cost:** near zero if the tool already exists; otherwise it *is* a port
  question again.

### B. Push-only channel (e.g. self-hosted ntfy)

PC POSTs `remote-status.txt` to an ntfy topic on each refresh (outbound HTTPS
only — no listening port). Phone subscribes to the topic for status, and
publishes goal text to the same topic; the PC runs an outbound subscriber
(`ntfy sub`, a long-lived HTTPS GET) feeding the inbox.

- **Exposes:** both directions to the ntfy server. Public ntfy.sh sees the
  status and goal text; a self-hosted ntfy keeps it on owner's infra. Topic
  name is a bearer secret — anyone who knows it can read/write.
- **Goal check:** same gate; subscriber writes complete messages as inbox
  files.
- **Threats:** third-party sees goal text unless self-hosted; topic secrecy;
  message replay/duplicates (watcher dedupes by hash); a compromised phone or
  leaked topic can inject pending goals (owner approval is the control).
- **Cost:** small — one publish hook in the refresh path, one subscriber
  process, no ports.

### C. Git-based inbox on a private repo

A private repo (e.g. GitHub) holds `status.txt` and `goals/*.md`. PC `git
push`es status on refresh; a timer runs `git fetch` and treats new files under
`goals/` as inbox entries.

- **Exposes:** status + goal text to the git host; phone needs a way to commit
  (GitHub app / git client) — clunkiest phone UX of the three.
- **Goal check:** same gate; only committed files count, so partial writes
  can't arrive.
- **Threats:** git credentials on the phone; repo write access = ability to
  propose goals; force-push/history noise (watcher only reads new commits);
  status file churn in git history.
- **Cost:** medium — push/pull plumbing, phone-side commit friction.

## Threats common to all options

- **Prompt injection:** an inbox goal becomes instructions to an agent with a
  real CLI. Mitigations: owner approval shows the text before it runs; the
  sandbox/guardrails already bound what workers can touch; goals can be
  capped in size and the watcher can flag suspicious content, but the owner
  is the real filter.
- **Confidentiality:** `remote-status.txt` is sanitized, but raw goal text and
  whatever the phone types is not — pick a channel the owner trusts with it.
- **Write access = propose access:** every option lets the phone side propose
  goals; approval-on-desktop is what keeps that safe.
- **Status spoofing:** a tampered `remote-status.txt` only misleads the glance;
  it cannot trigger actions. Low risk.
- **Nothing runs unattended:** practice mode, pacing, limits and `needsOwner()`
  are unchanged; remote goals get no privileges keyboard goals don't have.

## Recommendation

1. **If the owner already syncs a folder (A):** use it — least new machinery,
   device-to-device encryption, no third party. Add `remote-status.txt` (read
   side) and `goal-inbox/` (write side) to the synced set.
2. **Otherwise B with a self-hosted ntfy** is the best fit for "no port":
   outbound-only both ways, simple phone app, tiny surface.
3. **C only if the owner lives in git anyway** — the phone-side commit step
   makes it the weakest UX.

In all cases the status half can reuse `constance-remote.mjs` as-is; only the
inbox watcher and approval step are new code, and both stay off until the
owner picks a channel and says OK.
