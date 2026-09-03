#!/usr/bin/env bash
# Carry published patches between the guest's library checkout and GitHub.
#
# The guest is deliberately credential-free: a fully compromised mathvm gains
# nothing an internet stranger does not already have, and a push token for a
# public repository would end that. So the verifier commits a promoted patch
# locally, and this script, on the host with the operator's gh credential, is what
# publishes it. It also pulls the other way, so a commit made on GitHub reaches
# the library the ledger builds against.
#
#   tools/publish-lemma-lib.sh          sync both directions
#   tools/publish-lemma-lib.sh --status what each side has, change nothing
#
# Idempotent and safe to run on a timer: with nothing to do it is two fetches.
set -euo pipefail

CLONE=${LEMMA_LIB_CLONE:-$HOME/projects/LemmaLib}
GUEST=${LEMMA_LIB_GUEST:-mathvm:/srv/lemma-lib}
GUEST_HOST=${GUEST%%:*}
GUEST_PATH=${GUEST#*:}
BRANCH=${LEMMA_LIB_BRANCH:-main}

if [[ ! -d $CLONE/.git ]]; then
  echo "cloning hara-seihun/LemmaLib into $CLONE"
  git clone -q https://github.com/hara-seihun/LemmaLib.git "$CLONE"
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

fast_forward_local() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "$CLONE has local changes; refusing to move it" >&2
    return 1
  fi
  git merge --ff-only -q "$1"
}

module_of() {
  case $1 in
    LemmaLib.lean) echo LemmaLib ;;
    LemmaLib/*.lean) echo "${1%.lean}" | tr / . ;;
  esac
}

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
  fast_forward_local "$origin"
  echo "LemmaLib is in sync at ${origin:0:8}"
  exit 0
fi

if git merge-base --is-ancestor "$origin" "$guest"; then
  echo "publishing $(git rev-list --count "$origin..$guest") commit(s) from the guest:"
  git log --oneline "$origin..$guest"
  git push -q origin "$guest:refs/heads/$BRANCH"
  git fetch -q origin "$BRANCH"
  fast_forward_local "$guest"
  echo "pushed to hara-seihun/LemmaLib"
  exit 0
fi

if git merge-base --is-ancestor "$guest" "$origin"; then
  echo "origin is ahead; updating the guest checkout"
  changed=$(git diff --name-only "$guest..$origin")
  if grep -Eq '^(LemmaLib(/.*)?\.lean|lakefile\.toml|lake-manifest\.json|lean-toolchain)$' <<< "$changed"; then
    ssh "$GUEST_HOST" "sudo /srv/lemma-dev/tools/update-lemma-lib"
    mapfile -t deleted < <(
      git diff --name-only --diff-filter=D "$guest..$origin" -- LemmaLib.lean LemmaLib \
        | while read -r path; do module_of "$path"; done
    )
    index_modules=(LemmaLib "${deleted[@]}")
    printf -v index_args ' %q' "${index_modules[@]}"
    ssh "$GUEST_HOST" \
      "sudo -u math env HOME=/var/lib/math-research ELAN_HOME=/var/lib/math-research/.elan PATH=/var/lib/math-research/.elan/bin:/run/current-system/sw/bin /srv/math-research/tools/index-decls.sh$index_args && sudo -u postgres psql -v ON_ERROR_STOP=1 -d math -c \"delete from lean_check where source like '%import LemmaLib%'\""
  else
    ssh "$GUEST_HOST" "sudo -u math git -C '$GUEST_PATH' pull --ff-only -q"
  fi
  ssh "$GUEST_HOST" "sudo -u math git -C '$GUEST_PATH' config core.sharedRepository world"
  fast_forward_local "$origin"
  echo "guest now at $(ssh "$GUEST_HOST" "sudo -u math git -C '$GUEST_PATH' rev-parse --short HEAD")"
  exit 0
fi

echo "the two sides have diverged, which this script will not resolve on its own:" >&2
status >&2
exit 1
