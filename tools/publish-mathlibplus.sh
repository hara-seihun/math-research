#!/usr/bin/env bash
# Carry published patches between the guest's library checkout and GitHub.
#
# The guest is deliberately credential-free: a fully compromised mathvm gains
# nothing an internet stranger does not already have, and a push token for a
# public repository would end that. So the verifier commits a promoted patch
# locally, and this — on the host, with the operator's gh credential — is what
# publishes it. It also pulls the other way, so a commit made on GitHub reaches
# the library the ledger builds against.
#
#   tools/publish-mathlibplus.sh          sync both directions
#   tools/publish-mathlibplus.sh --status what each side has, change nothing
#
# Idempotent and safe to run on a timer: with nothing to do it is two fetches.
set -euo pipefail

CLONE=${MATHLIBPLUS_CLONE:-$HOME/projects/mathlibplus}
GUEST=${MATHLIBPLUS_GUEST:-mathvm:/srv/mathlibplus}
GUEST_HOST=${GUEST%%:*}
GUEST_PATH=${GUEST#*:}
BRANCH=${MATHLIBPLUS_BRANCH:-main}

if [[ ! -d $CLONE/.git ]]; then
  echo "cloning hara-seihun/mathlibplus into $CLONE"
  git clone -q https://github.com/hara-seihun/mathlibplus.git "$CLONE"
fi
cd "$CLONE"
git remote get-url guest > /dev/null 2>&1 || git remote add guest "$GUEST"
git remote set-url guest "$GUEST"
# The guest's checkout belongs to `math` and the verifier writes it with a
# private umask, so read it as `math` rather than depending on its file modes.
git config remote.guest.uploadpack "sudo -u math git-upload-pack"

git fetch -q origin "$BRANCH"
git fetch -q guest "$BRANCH"
origin=$(git rev-parse "origin/$BRANCH")
guest=$(git rev-parse "guest/$BRANCH")

status() {
  echo "origin/$BRANCH $(git log -1 --format='%h %s' "$origin")"
  echo "guest/$BRANCH  $(git log -1 --format='%h %s' "$guest")"
  if [[ $origin == "$guest" ]]; then
    echo "in sync"
  else
    echo "guest ahead by $(git rev-list --count "$origin..$guest"), origin ahead by $(git rev-list --count "$guest..$origin")"
  fi
}

if [[ ${1:-} == --status ]]; then
  status
  exit 0
fi

if [[ $origin == "$guest" ]]; then
  echo "mathlibplus is in sync at ${origin:0:8}"
  exit 0
fi

if git merge-base --is-ancestor "$origin" "$guest"; then
  echo "publishing $(git rev-list --count "$origin..$guest") commit(s) from the guest:"
  git log --oneline "$origin..$guest"
  git push -q origin "$guest:refs/heads/$BRANCH"
  git fetch -q origin "$BRANCH"
  echo "pushed to hara-seihun/mathlibplus"
  exit 0
fi

if git merge-base --is-ancestor "$guest" "$origin"; then
  echo "origin is ahead; fast-forwarding the guest's checkout"
  ssh "$GUEST_HOST" "sudo -u math git -C '$GUEST_PATH' pull --ff-only -q"
  echo "guest now at $(ssh "$GUEST_HOST" "sudo -u math git -C '$GUEST_PATH' rev-parse --short HEAD")"
  echo "note: modules changed by those commits are stale in the ledger's build tree and index."
  exit 0
fi

echo "the two sides have diverged, which this script will not resolve on its own:" >&2
status >&2
exit 1
