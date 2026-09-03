#!/usr/bin/env bash
# shellcheck disable=SC2029 # This host intentionally expands validated values into remote commands.
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
INDEXED_COMMIT=/var/lib/math-research/patch-work/indexed-commit

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

indexed_commit() {
  ssh "$GUEST_HOST" "sudo -u math cat '$INDEXED_COMMIT' 2>/dev/null || true"
}

status() {
  local indexed
  indexed=$(indexed_commit)
  echo "origin/$BRANCH $(git log -1 --format='%h %s' "$origin")"
  echo "guest/$BRANCH  $(git log -1 --format='%h %s' "$guest")"
  echo "guest indexed   ${indexed:-never}"
  if [[ $origin == "$guest" && $indexed == "$guest" ]]; then
    echo "in sync"
  elif [[ $origin == "$guest" ]]; then
    echo "source is in sync; the guest build or index still needs reconciliation"
  else
    echo "guest ahead by $(git rev-list --count "$origin..$guest"), origin ahead by $(git rev-list --count "$guest..$origin")"
  fi
}

# Bring the guest's source, build, declaration index and check cache to one
# commit. The marker is written last, so any interrupted run is retried even if
# Git was already fast-forwarded. Checker services stay down while their oleans
# and cache generation change; the EXIT trap restores them after failures too.
reconcile_guest() {
  local target=$1 applied changed mode=full quoted
  local -a modules=()
  applied=$(indexed_commit)
  [[ $applied == "$target" ]] && return 0

  if [[ -n $applied ]] && git cat-file -e "$applied^{commit}" 2> /dev/null \
      && git merge-base --is-ancestor "$applied" "$target"; then
    changed=$(git diff --name-only "$applied..$target")
    if grep -Eq '^(lakefile\.toml|lake-manifest\.json|lean-toolchain)$' <<< "$changed"; then
      mode=full
    elif grep -Eq '^LemmaLib(/.*)?\.lean$' <<< "$changed"; then
      mode=incremental
      mapfile -t modules < <(
        git diff --name-only "$applied..$target" -- LemmaLib.lean LemmaLib \
          | while read -r path; do module_of "$path"; done | sort -u
      )
    elif grep -Eq '\.lean$' <<< "$changed"; then
      mode=build
    else
      mode=none
    fi
  fi

  if [[ $mode == none ]]; then
    ssh "$GUEST_HOST" "set -e; sudo -u math git -C '$GUEST_PATH' pull --ff-only -q; test \"\$(sudo -u math git -C '$GUEST_PATH' rev-parse HEAD)\" = '$target'; sudo -u math install -d '$(dirname "$INDEXED_COMMIT")'; printf '%s\\n' '$target' | sudo -u math tee '$INDEXED_COMMIT' >/dev/null"
    return 0
  fi

  printf -v quoted ' %q' "$target" "$mode" "${modules[@]}"
  ssh "$GUEST_HOST" "sudo bash -s --$quoted" <<'REMOTE'
set -euo pipefail
target=$1
mode=$2
shift 2
marker=/var/lib/math-research/patch-work/indexed-commit
restart_checkers() { systemctl start lean-runner math-verifier; }
trap restart_checkers EXIT

systemctl stop math-verifier lean-runner
/srv/lemma-dev/tools/update-lemma-lib
actual=$(sudo -u math git -C /srv/lemma-lib rev-parse HEAD)
[[ $actual == "$target" ]] || {
  echo "guest reached $actual instead of requested $target" >&2
  exit 1
}

if [[ $mode == full ]]; then
  sudo -u math env HOME=/var/lib/math-research ELAN_HOME=/var/lib/math-research/.elan \
    PATH=/var/lib/math-research/.elan/bin:/run/current-system/sw/bin \
    /srv/math-research/tools/index-decls.sh
elif [[ $mode == incremental ]]; then
  sudo -u math env HOME=/var/lib/math-research ELAN_HOME=/var/lib/math-research/.elan \
    PATH=/var/lib/math-research/.elan/bin:/run/current-system/sw/bin \
    /srv/math-research/tools/index-decls.sh "$@"
fi

if [[ $mode != build ]]; then
  sudo -u math /srv/math-research/tools/invalidate-library-checks.sh LemmaLib
fi
sudo -u math install -d "$(dirname "$marker")"
printf '%s\n' "$target" | sudo -u math tee "$marker" > /dev/null
REMOTE
}

if [[ ${1:-} == --status ]]; then
  status
  exit 0
fi

if [[ $origin == "$guest" ]]; then
  fast_forward_local "$origin"
  reconcile_guest "$origin"
  echo "LemmaLib is in sync at ${origin:0:8}"
  exit 0
fi

if git merge-base --is-ancestor "$origin" "$guest"; then
  reconcile_guest "$guest"
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
  reconcile_guest "$origin"
  ssh "$GUEST_HOST" "sudo -u math git -C '$GUEST_PATH' config core.sharedRepository world"
  fast_forward_local "$origin"
  echo "guest now at $(ssh "$GUEST_HOST" "sudo -u math git -C '$GUEST_PATH' rev-parse --short HEAD")"
  exit 0
fi

echo "the two sides have diverged, which this script will not resolve on its own:" >&2
status >&2
exit 1
