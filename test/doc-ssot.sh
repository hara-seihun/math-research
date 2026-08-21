#!/usr/bin/env bash
# One fact, one file.
#
# The prose here is written by many hands and read by agents in-band, so a
# second copy of a fact is not a style problem: it is a copy that will be
# wrong. This ran for the first time against a tree where the pinned Mathlib
# version was typed into seven files, `search`'s filter list disagreed between
# the guide, the README and the server's own greeting, and the guide agents
# actually read had never heard of amendments.
#
# Two rules, both mechanical:
#   1. A version the Lake project pins appears nowhere else.
#   2. The rules of the place are stated in guides/how-this-works.md and
#      nowhere else. The server may describe its own tools (those descriptions
#      are generated, not copied), and the guides may teach; the README and the
#      site pages link instead.
#   3. Every guide carries intact `when:` front matter. A guide whose
#      delimiters get reformatted still renders as a page, so nothing looks
#      broken, but its `when:` line silently becomes body text and the MCP
#      prompt it backs advertises no trigger at all. That shipped once: a
#      markdown formatter turned attack.md's opening `---` into `***` and its
#      closing `---` into a setext underline, and the guide agents most need
#      went out with an empty description.
# Plus a typo guard: every {{placeholder}} in published prose is one something
# actually fills in.
#
# Needs nothing but the checkout and bun. Runs first in test/contracts.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
source test/under-a-minute.sh

failed=0
fail() {
  printf 'doc-ssot: %s\n' "$1" >&2
  shift
  printf '  %s\n' "$@" >&2
  failed=1
}

# The one parser, exercised here so a broken pinned.ts fails a test rather
# than a deploy.
unset LEAN_DIR
readarray -t PINNED < <(bun -e '
  const { pins } = await import("./server/src/pinned.ts");
  for (const [name, value] of Object.entries(pins())) console.log(`${name}\t${value}`);
')
[[ ${#PINNED[@]} -gt 0 ]] || { echo "doc-ssot: server/src/pinned.ts named no versions" >&2; exit 1; }

# Where a pinned version is allowed to appear as a literal: the project that
# pins it, the module that reads it, and this test.
version_owner='^(lean/|server/src/pinned\.ts$|test/doc-ssot\.sh$)'

for entry in "${PINNED[@]}"; do
  name=${entry%%$'\t'*}
  value=${entry##*$'\t'}
  hits=$(git ls-files -z | xargs -0 grep -lF -- "$value" 2> /dev/null | grep -Ev "$version_owner" || true)
  [[ -z $hits ]] || fail \
    "$value is what lean/ pins, so prose asks for it with {{$name}} instead of naming it:" $hits
done

# Mechanics that belong to the guide. A page that needs one of these is a page
# restating the rules, and the fix is a link to the section that owns them.
owned_mechanics=(
  'T0 recorded'
  'T1 confirmed'
  'T2 canon'
  'T3 published'
  'not-mathematics'
  'review_queue'
  'review_claim'
  'apply_amendment'
  'apply_impact_assessment'
  'assesses-impact'
  'set_origin'
  'external_source'
  'origin_source'
  'SHA-256'
)
# Pages that link rather than tell. The guides teach, and the server describes
# its own tools -- the tool reference on the site is generated from those
# descriptions, so it cannot drift from the implementation.
links_rather_than_tells=(README.md site/content/*.md)

for page in "${links_rather_than_tells[@]}"; do
  for phrase in "${owned_mechanics[@]}"; do
    line=$(grep -nF -- "$phrase" "$page" | head -1 || true)
    [[ -z $line ]] || fail \
      "$page states a rule guides/how-this-works.md owns ('$phrase'). Link the section instead:" "$line"
  done
done

# Front matter, checked with the server's own reader so this test and the
# shelf cannot disagree about what counts as intact.
readarray -t SHELF < <(bun -e '
  const { guides } = await import("./server/src/guides.ts");
  for (const g of guides()) console.log(`${g.name}\t${g.when}\t${g.about}`);
')
[[ ${#SHELF[@]} -gt 0 ]] || { echo "doc-ssot: the guide shelf is empty" >&2; exit 1; }
for entry in "${SHELF[@]}"; do
  IFS=$'\t' read -r name when about <<< "$entry"
  [[ -n $when ]] || fail \
    "guides/$name.md has no when: front matter, so its prompt would advertise no trigger:" \
    "$(head -3 "guides/$name.md")"
  [[ -n $about && $about != '#'* ]] || fail \
    "guides/$name.md does not open with its H1, so the shelf has no title for it:" \
    "$(head -1 "guides/$name.md")"
done

# Holes something fills in. `guides` expands the pinned ones as it serves a
# guide; the site build expands these and its own.
known_placeholders='mathlib_version|lean_version|how_it_works_digest|ledger_snapshot|tool_reference|resource_reference|prompt_reference|results_js'
unknown=$(grep -rhoE '\{\{[a-z_]+\}\}' guides site/content \
  | sort -u | grep -Ev "^\{\{($known_placeholders)\}\}$" || true)
[[ -z $unknown ]] || fail "nothing fills these in:" $unknown

[[ $failed -eq 0 ]] && echo "doc-ssot: one fact, one file"
exit $failed
