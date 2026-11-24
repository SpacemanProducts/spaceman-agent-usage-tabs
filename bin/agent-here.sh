#!/bin/bash
# The header terminal button: start Omarchy's default agent in a folder picked in the panel.
# The panel runs it inside a terminal (omarchy-launch-tui --app-id=org.omarchy.agent, the stock agent window, tiled).
# Environment: AGENT_DIR = start in this folder; AGENT_NEW = create this project in ~/Projects first (git set up).
# The folder list is the same one the CS button uses (bin/folders.sh): a git repo opened here becomes the "last one" there too.
# The bar's right-click and the keyboard shortcut don't come here: they run omarchy-agent straight away, with no picker.
HERE=$(dirname "$(readlink -f "$0")")
export PATH="$HOME/.local/bin:$PATH"
source "$HERE/folders.sh"
pause() { read -rn1 -p "Press any key to close "; }
pick_state="$(dirname "$state")/start-picks"
# Every folder started from the Start picker is remembered, repo or not, so the picker can keep it visible.
remember_pick() { [[ -n $1 && $1 != "$HOME" ]] || return 0; mkdir -p "$(dirname "$pick_state")"; { echo "$1"; grep -vxF "$1" "$pick_state" 2>/dev/null; } | head -20 >"$pick_state.new" && mv "$pick_state.new" "$pick_state"; }

dir=${AGENT_DIR:-}
if [[ -n ${AGENT_NEW:-} ]]; then      # a plain folder name, made in ~/Projects with git set up
  [[ $AGENT_NEW != */* && $AGENT_NEW != .* ]] || { echo "Use a plain folder name."; pause; exit 1; }
  dir="$PROJECTS/$AGENT_NEW"
  if ! is_repo "$dir"; then mkdir -p "$dir" && init_repo "$dir" || { echo "Couldn't create $dir"; pause; exit 1; }; fi
fi
[[ -n $dir && -d $dir ]] || { echo "No such folder: ${dir:-(none)}"; pause; exit 1; }
remember_pick "$dir"

# Only a git repo goes on the recent list (a plain folder is fine for an agent, but the list is of repos).
if is_repo "$dir"; then
  remember "$dir"
  mkdir -p "$(dirname "$state")" && printf '%s\n' "$dir" >"$state"
fi

cd "$dir" || { echo "Couldn't open $dir"; pause; exit 1; }

# Skip-permission flags, verified against each agent's own --help. The panel's
# skipPermissions setting (settings.json, on by default) decides whether they
# are added; off launches the agent bare, so its own prompts come back.
agent_base_args() {
  case "$1" in
    kiro-cli) echo "chat" ;;
    dsh) echo "web" ;;
    *) echo "" ;;
  esac
}
agent_skip_args() {
  case "$1" in
    claude) echo "--dangerously-skip-permissions" ;;
    copilot) echo "--allow-all" ;;
    agy|antigravity) echo "--dangerously-skip-permissions" ;;
    codex) echo "--dangerously-bypass-approvals-and-sandbox" ;;
    cursor-agent) echo "--yolo --trust" ;;
    grok) echo "--permission-mode bypassPermissions" ;;
    devin) echo "--permission-mode dangerous --respect-workspace-trust false" ;;
    opencode) echo "--auto" ;;
    kimi) echo "--auto" ;;
    kiro-cli) echo "--trust-all-tools --trust-workspace" ;;
    amp) echo "--dangerously-allow-all" ;;
    qwen) echo "--yolo" ;;
    dsh) echo "" ;;
    *) echo "" ;;
  esac
}
agent_known() {
  case "$1" in
    claude|copilot|agy|antigravity|codex|cursor-agent|grok|devin|opencode|kimi|kiro-cli|amp|qwen|dsh) return 0 ;;
    *) return 1 ;;
  esac
}

settings_json="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/agent-usage-tabs/settings.json"
skip_on=1
if [[ -f $settings_json ]]; then
  skip_on=$(python3 -c 'import json,sys
try: v=json.load(open(sys.argv[1])).get("skipPermissions")
except Exception: v=None
print("0" if v is False else "1")' "$settings_json" 2>/dev/null || echo 1)
fi

agent=$(omarchy-default-agent 2>/dev/null || true)
if [[ -n $agent ]] && agent_known "$agent" && ! omarchy-cmd-missing "$agent" 2>/dev/null; then
  # Same account pinning omarchy-agent applies for these three (a new session
  # uses the current selection rather than its parent's account pin).
  account_env=()
  case "$agent" in
    claude) home_env="CLAUDE_CONFIG_DIR" ;;
    codex) home_env="CODEX_HOME" ;;
    grok) home_env="GROK_HOME" ;;
    *) home_env="" ;;
  esac
  if [[ -n $home_env ]]; then
    account_pin="OMARCHY_AGENT_${agent^^}_HOME"
    if [[ -v $account_pin && ${!home_env:-} == "${!account_pin}" ]]; then unset "$home_env"; fi
    unset "$account_pin"
    if [[ -z ${!home_env:-} ]]; then
      home=$(omarchy-agent-account-home "$agent" 2>/dev/null || true)
      account_env=(env -u "$home_env" "OMARCHY_AGENT_${agent^^}_HOME=$home")
      [[ -n $home ]] && account_env+=("$home_env=$home")
    fi
  fi
  base=(); skip=()
  [[ -n $(agent_base_args "$agent") ]] && read -ra base <<< "$(agent_base_args "$agent")"
  if [[ $skip_on == 1 && -n $(agent_skip_args "$agent") ]]; then
    read -ra skip <<< "$(agent_skip_args "$agent")"
    [[ $agent == dsh ]] && account_env=(env "DSH_PERMISSION_MODE=danger-full-access" "${account_env[@]}")
  fi
  exec "${account_env[@]}" "$agent" "${base[@]}" "${skip[@]}"
fi

# --inline: this terminal is the agent's window. --pick: with no default agent set, offer the choice instead of an error.
exec omarchy-agent --inline --pick
