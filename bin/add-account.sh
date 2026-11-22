#!/bin/bash
# The panel's + button: Omarchy's own add-subscription flow (omarchy-agent-account-add),
# run in a terminal. Usage: add-account.sh [provider]. The provider is the selected tab when
# it is claude, codex or grok; otherwise it is asked. A further account is asked for a name,
# as the stock panel does. Nothing here reads or stores credentials: the CLI does the sign-in.
set -uo pipefail

provider=${1:-}
case "$provider" in
claude | codex | grok) ;;
*)
  provider=$(printf '%s\n' claude codex grok | gum choose --header "Add a subscription for:") || exit 130
  ;;
esac

state=$(omarchy-agent-account-add --check | awk -v p="$provider" '$1 == p { print $2 }')
label=""
if [[ $state == "additional" ]]; then
  label=$(gum input --header "Name this $provider account" --placeholder "Work") || exit 130
fi

if [[ -n $label ]]; then
  omarchy-agent-account-add "$provider" "$label"
else
  omarchy-agent-account-add "$provider"
fi
