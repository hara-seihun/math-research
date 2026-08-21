#!/usr/bin/env bash
# Rebuild the declaration index behind `search_decls`, on the guest, as `math`.
#
#   tools/index-decls.sh                   everything importable: the pinned
#                                          toolchain, Mathlib and its packages,
#                                          and every built MathlibPlus module
#   tools/index-decls.sh MathlibPlus.A …   just these modules, which is what the
#                                          patch publisher runs after installing
#                                          new oleans
#
# lean/DumpDecls.lean does the extraction: it imports already-built oleans and
# writes one JSON object per declaration. Nothing is elaborated, so the cost is
# olean loading and pretty-printing rather than a build — but pretty-printing
# half a million declarations is still tens of minutes, so the full pass runs
# in batches, one process per batch.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=${DECL_INDEX_DIR:-/var/lib/math-research/decl-index}
LEAN_DIR=${LEAN_DIR:-/srv/math-research/lean}
PLUS_BUILD=${MATHLIBPLUS_BUILD:-/srv/mathlibplus/.lake/build/lib/lean}
BATCH=${DECL_INDEX_BATCH:-200}
# One at a time by default: a batch's memory is its transitive import closure,
# which for anything touching Mathlib is most of Mathlib, and two of those at
# once OOM a 23 GiB guest that is also serving.
JOBS=${DECL_INDEX_JOBS:-1}
# Metaprogramming and build-tool internals are importable but are not what
# anyone is searching for when they are looking for a lemma.
SKIP=${DECL_INDEX_SKIP:-'^(Lean|Lake|Cli|ImportGraph|LeanSearchClient|ProofWidgets|REPL|Repl)\.'}

mkdir -p "$WORK"
cp lean/DumpDecls.lean "$WORK/DumpDecls.lean"

eval "$(sed -n 's/^LEAN_PATH=/export LEAN_PATH=/p' "$LEAN_DIR/.env-cache")"
export LEAN_PATH="$LEAN_PATH:$PLUS_BUILD"
export ELAN_HOME=${ELAN_HOME:-/var/lib/math-research/.elan}
export ELAN_TOOLCHAIN=${ELAN_TOOLCHAIN:-$(cat "$LEAN_DIR/lean-toolchain")}
export PATH=/run/current-system/sw/bin:$PATH

# A batch that cannot be imported is bisected in fresh processes: MathlibPlus
# declares the same name in more than one module, and two of those together are
# a hard import error that says nothing about which pair is at fault.
dump() { # <modules-file> <out.jsonl> — leaves the .jsonl only on success
  local mods=$1 out=$2 count
  if lean --run "$WORK/DumpDecls.lean" "$mods" "$out.part" 2>> "$mods.log"; then
    mv "$out.part" "$out"
    return 0
  fi
  rm -f "$out.part"
  count=$(wc -l < "$mods")
  if [[ $count -le 1 ]]; then
    echo "UNIMPORTABLE $(cat "$mods")" >> "$mods.log"
    return 0
  fi
  head -n $((count / 2)) "$mods" > "$mods.a"
  tail -n +$((count / 2 + 1)) "$mods" > "$mods.b"
  dump "$mods.a" "$out.a"
  dump "$mods.b" "$out.b"
}
export -f dump

load() { # <jsonl…> — replaces exactly the modules the dumps cover
  local staged=()
  # A .part is a dump that was interrupted, and loading half a module's
  # declarations would replace good rows with a truncated set.
  for f in "$@"; do [[ -s $f && $f != *.part ]] && staged+=("$f"); done
  [[ ${#staged[@]} -gt 0 ]] || { echo "nothing dumped, nothing loaded" >&2; return 1; }
  {
    echo "begin;"
    echo "create temp table decl_in (j jsonb) on commit drop;"
    for f in "${staged[@]}"; do
      # CSV framing with delimiters that cannot occur in JSON, because the text
      # format would eat every backslash escape inside a statement.
      printf "\\\\copy decl_in (j) from '%s' with (format csv, quote e'\\\\x01', delimiter e'\\\\x02')\n" "$f"
    done
    cat <<'SQL'
delete from lean_decl d using (select distinct j->>'module' as module from decl_in) m
 where d.module = m.module;
insert into lean_decl (module, name, library, kind, statement, is_proof, indexed_at)
select distinct on (j->>'module', j->>'name')
       j->>'module', j->>'name', split_part(j->>'module', '.', 1),
       j->>'kind', j->>'statement', (j->>'is_proof')::boolean, now()
  from decl_in
 on conflict (module, name) do update
    set library = excluded.library, kind = excluded.kind, statement = excluded.statement,
        is_proof = excluded.is_proof, indexed_at = excluded.indexed_at;
commit;
analyze lean_decl;
select library, count(*) from lean_decl group by library order by 2 desc;
SQL
  } | psql -q -v ON_ERROR_STOP=1 -d math
}

if [[ $# -gt 0 ]]; then
  rm -f "$WORK"/incremental-mods.txt* "$WORK"/incremental.jsonl*
  printf '%s\n' "$@" > "$WORK/incremental-mods.txt"
  dump "$WORK/incremental-mods.txt" "$WORK/incremental.jsonl"
  load "$WORK"/incremental.jsonl*
  exit 0
fi

# Every module anyone here can import is an olean on LEAN_PATH, so that is the
# index's definition of "available". Sorted, so a batch tends to hold one
# library and one subtree of it.
rm -rf "$WORK/batches"
mkdir -p "$WORK/batches"
for dir in ${LEAN_PATH//:/ }; do
  [[ -d $dir ]] && (cd "$dir" && find . -name '*.olean' -printf '%P\n')
done | sed 's/\.olean$//; s|/|.|g' | grep -Ev "$SKIP" | sort -u > "$WORK/modules.txt"
echo "$(wc -l < "$WORK/modules.txt") importable modules"

split -l "$BATCH" -d -a 4 "$WORK/modules.txt" "$WORK/batches/batch."
(cd "$WORK/batches" && ls | grep '^batch\.[0-9]*$') \
  | WORK="$WORK" xargs -P "$JOBS" -I{} bash -c 'dump "$WORK/batches/{}" "$WORK/batches/{}.jsonl"'

load "$WORK"/batches/*.jsonl*
grep -h UNIMPORTABLE "$WORK"/batches/*.log 2>/dev/null | sort -u > "$WORK/unimportable.txt" || true
echo "modules that could not be imported: $(wc -l < "$WORK/unimportable.txt") (see $WORK/unimportable.txt)"
