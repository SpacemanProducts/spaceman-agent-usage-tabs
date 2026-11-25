# Remote control — proposal (not enabled)

Goal: check on Constance and add goals from a phone, without exposing
anything. Two steps. **Nothing here is turned on yet** — opening a port or
sending data to an outside service needs the owner's OK first.

## Step 1 — look, don't touch (read-only)

`bin/constance-remote.mjs` turns `node bin/constance.mjs status` into a short
plain-text summary (goal, checklist ticks, job counts, Session/Weekly usage,
practice flag). It is built only from safe fields and strips anything that
looks like a path or an email, so prompts, reports, log text and home-folder
details can never appear in it.

The summary is written to a file and kept fresh (rewrite it whenever status
changes or on a timer). The phone reads that file through a channel the owner
picks. Three options:

| Option | What it needs | Listens on a port? | What leaves the machine |
| --- | --- | --- | --- |
| Syncthing-shared folder | Syncthing on the PC and phone, paired once | No inbound port (it dials out) | The summary file goes phone↔PC directly, encrypted |
| Tailscale + SSH forced command | Tailscale on both, one SSH key on the phone locked to a read-only command that prints the file | SSH only on the tailnet, not the LAN | Nothing leaves the tailnet; phone pulls the file on demand |
| Outbound push (e.g. ntfy) | An ntfy topic (self-hosted or public) | No | The summary is POSTed to the ntfy server; phone subscribes |

All three avoid opening anything to the internet. Syncthing and Tailscale
keep the file between your own devices; ntfy is the simplest but hands the
summary to a third-party server (a self-hosted ntfy avoids that).

**Status: none enabled. Pick one and say OK before any port opens or any
data leaves the machine.**

## Step 2 — add goals from the phone (later, after OK)

A drop folder ("inbox") the phone can write one small text file into. A
Constance watcher picks it up and:

- caps the text (a goal is a few lines, not a document),
- only ever runs `C goals add` with it — it becomes a queued goal like any
  other,
- never executes anything in the file, never treats it as a command,
- never starts while practice mode is on or the pace/limits say no — the
  existing queue and pacing rules decide exactly as they do for goals typed
  at the keyboard.

Same rule as step 1: the inbox folder and its watcher stay off until the
owner approves a channel and the setup.
