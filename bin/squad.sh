#!/bin/bash
# The Squad button: run Claude Squad (`cs`) with one agent, in a git repo folder.
# Usage: squad.sh <agent-cli>...    squad.sh --install   (install Claude Squad)
# ONE window, however many agents: it starts a Claude Squad session per agent inside cs (bin/squad-drive.py). Its app-id
# is org.omarchy.squad (not org.omarchy.bash, which Omarchy's window rules float), so it opens as a normal tiled window.
# The folder: $SQUAD_DIR, else the last one used. Otherwise a picker offers recent git repos, "Create a new project"
# (in ~/Projects, git-initialized with a first commit) and "Browse..." for anywhere else.
HERE=$(dirname "$(readlink -f "$0")")
# Squad windows already open when this one started (the driver closes any others that show up later).
SQUAD_WINDOWS_BEFORE=$(hyprctl clients -j 2>/dev/null | jq -r '[.[]|select(.class=="org.omarchy.squad")|.pid]|join(",")' 2>/dev/null)
arg=${1:?usage: squad.sh <agent-cli>... | --install}
export PATH="$HOME/.local/bin:$PATH"
INSTALL='curl -fsSL https://raw.githubusercontent.com/smtg-ai/claude-squad/main/install.sh | bash'

install_cs() {
  echo "Installing Claude Squad (needs tmux and git):"
  echo "  $INSTALL"
  echo
  bash -c "$INSTALL"
  hash -r
}
pause() { read -rn1 -p "Press any key to close "; }

if [[ $arg == --install ]]; then install_cs; command -v cs >/dev/null && echo "Done: cs is installed." || echo "cs still not found."; pause; exit; fi
clis=("$@")

# One Squad window at a time (the driver holds this lock while its window is open): two cs processes would overwrite each
# other's saved sessions. Checked first, so a second launch says so before asking for a folder.
LOCK="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/agent-usage-tabs/squad.lock"
mkdir -p "$(dirname "$LOCK")"
if ! flock -n "$LOCK" true; then
  echo "Claude Squad is already open in another window."
  echo "Use that one, or close it and launch again."
  pause; exit 1
fi

if ! command -v cs >/dev/null; then
  echo "Squad needs Claude Squad (cs)."
  gum confirm "Install it now?" || exit 130
  install_cs
  command -v cs >/dev/null || { echo "cs still not found; see github.com/smtg-ai/claude-squad"; pause; exit 1; }
fi

state="${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/agent-usage-tabs/squad-dir"
is_repo() { [[ -n $1 ]] && git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1; }
# Squad branches from HEAD, so a fresh repo needs a first commit.
init_repo() { git -C "$1" init -q && git -C "$1" commit -q --allow-empty -m "Initial commit"; }

# The picker has three things: recent git repos, "Create a new project", and "Browse" for anywhere else.
# Recent = repos you picked before, plus the git repos in ~/Projects, newest first. Backups and desktop files are
# hidden (hidden folders, *backup*/*.bak*, date-stamped or before-/pre- copies, *.desktop, Desktop).
PROJECTS="${SQUAD_PROJECTS:-$HOME/Projects}"
recent="$(dirname "$state")/squad-recent"
is_hidden() { case "/$1/" in */.*|*backup*|*Backup*|*.bak*|*-before-*|*-pre[a-z]*/|*-20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]*|*.desktop/|*/Desktop/*) return 0 ;; esac; return 1; }
nice() { local p=$1; [[ $p == "$PROJECTS"/* ]] && echo "${p#"$PROJECTS"/}" || echo "${p/#$HOME/\~}"; }
recent_repos() {
  { [[ -f $recent ]] && cat "$recent"
    find "$PROJECTS" -maxdepth 3 -name .git -prune -printf '%T@ %h\n' 2>/dev/null | sort -nr | cut -d' ' -f2-
  } | awk 'NF && !seen[$0]++' | while IFS= read -r d; do
    is_repo "$d" && ! is_hidden "$(nice "$d")" && echo "$d"
  done | head -8
}
remember() { mkdir -p "$(dirname "$recent")"; { echo "$1"; grep -vxF "$1" "$recent" 2>/dev/null; } | head -8 >"$recent.new" && mv "$recent.new" "$recent"; }

# The picker always shows (SQUAD_DIR is only an override for scripts), with the last repo preselected: Enter reuses it.
last=""; [[ -f $state ]] && last=$(<"$state")
dir=${SQUAD_DIR:-}
if ! is_repo "$dir"; then
  declare -A path_of=(); labels=()
  while IFS= read -r d; do l=$(nice "$d"); path_of[$l]=$d; labels+=("$l"); done < <(recent_repos)
  selected=()
  if is_repo "$last"; then
    ll=$(nice "$last")
    [[ -n ${path_of[$ll]:-} ]] || { path_of[$ll]=$last; labels=("$ll" "${labels[@]}"); }   # never drop it from the list
    selected=(--selected "$ll")
  fi
  new="+ Create a new project"; browse="Browse..."
  choice=$(printf '%s\n' "${labels[@]}" "$new" "$browse" | sed '/^$/d' | gum choose "${selected[@]}" --header "Claude Squad: which git repo? (Enter = last one)") || exit 130
  if [[ $choice == "$new" ]]; then
    name=$(gum input --header "New project name" --placeholder "my-project") || exit 130
    [[ -n $name && $name != */* && $name != .* ]] || { echo "Use a plain folder name."; pause; exit 1; }
    dir="$PROJECTS/$name"
    mkdir -p "$dir" && init_repo "$dir" || { echo "Couldn't create $dir"; pause; exit 1; }
  elif [[ $choice == "$browse" ]]; then
    dir=$(gum file --directory --header "Choose a folder" "$HOME") || exit 130
    [[ -n $dir ]] || exit 130
    if ! is_repo "$dir"; then
      gum confirm "That folder isn't a git repo. Run git init there?" || exit 130
      init_repo "$dir" || { echo "git init failed in $dir"; pause; exit 1; }
    fi
  else
    dir=${path_of[$choice]}
  fi
fi
remember "$dir"
mkdir -p "$(dirname "$state")" && printf '%s\n' "$dir" >"$state"

# Say which repo this is about to open, and name the terminal after it.
name=$(basename "$dir")
printf '\033]0;%s\007' "$name"
echo "Claude Squad: $(IFS=,; echo "${clis[*]}") in $name"
echo "  ${dir/#$HOME/\~}"
sleep 1.2

# ONE window: squad-drive.py starts a session per agent inside cs (cs has no command line for that) and leaves you in
# cs. Without python3 it just opens cs on the first agent.
# It also closes any extra Claude Squad window that appeared since this one opened (there should be none: nothing here
# opens another terminal), so only this window remains.
DRIVER="${SQUAD_DRIVER:-$HERE/squad-drive.py}"
if command -v python3 >/dev/null && [[ -f $DRIVER ]]; then
  export SQUAD_WINDOWS_BEFORE="$SQUAD_WINDOWS_BEFORE"
  exec python3 "$DRIVER" "$dir" "${clis[@]}"
fi
cd "$dir" && exec cs -p "${clis[0]}"
