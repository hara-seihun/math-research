#!/usr/bin/env bash
# Dump what similarity-bench.ts measures against: the live corpus, the live
# declaration index, and the links agents have actually asserted between
# entries (which is the bench's ground truth). Reads the guest's database
# directly; writes JSON Lines into $1 (default .bench/).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-.bench}"
mkdir -p "$OUT"

# COPY escapes backslash, newline and tab; JSON text contains no raw newline,
# so undoing that escaping restores the exact JSON of each row.
unescape() {
  python3 -c '
import sys
for line in sys.stdin:
    line = line.rstrip("\n")
    out = line.replace("\\\\", "\x00").replace("\\n", "\n").replace("\\t", "\t").replace("\x00", "\\")
    sys.stdout.write(out + "\n")
'
}

dump() {
  ssh mathvm "sudo -u math psql -d math -At -c \"copy ($1) to stdout\"" | unescape > "$OUT/$2"
  printf '%s: %s rows\n' "$2" "$(wc -l < "$OUT/$2")"
}

# Inactive entries are dumped too: an entry withdrawn as a duplicate is
# exactly the query the bench needs, and its target is what a good ranker must
# find.
dump "select json_build_object('id',c.id,'kind',c.kind,'title',c.title,'summary',c.summary,
        'tier',c.tier,'notability',c.notability,'lean_verified',c.lean_verified,'status',c.status,
        'content',left(a.content,8000))
      from contribution c join artifact a on a.hash = c.artifact_hash
      where c.kind <> 'edge'" contribs.jsonl

dump "select json_build_object('src',e.src,'dst',e.dst,'rel',e.rel,'tier',ec.tier)
      from edge e join contribution ec on ec.id = e.contribution_id
      where ec.status = 'active'
        and e.rel in ('duplicate-of','equivalent-to','overlaps','specializes','generalizes','refines','supersedes','parallels')" edges.jsonl

dump "select json_build_object('name',name,'module',module,'library',library,'kind',kind,
        'is_proof',is_proof,'statement',statement)
      from lean_decl" decls.jsonl
