#!/usr/bin/env bash
# Requeue kernel verdicts whose source imports a library that just changed.
set -euo pipefail

prefix=${1:?usage: invalidate-library-checks.sh MODULE_PREFIX}
[[ $prefix =~ ^[A-Za-z0-9_.]+$ ]] || { echo "invalid module prefix: $prefix" >&2; exit 2; }
escaped=${prefix//./\\.}
pattern="import[[:space:]]+${escaped}\\M"

mapfile -t invalidated < <(
  psql -X -v ON_ERROR_STOP=1 -At -d "${PGDATABASE:-math}" -v pattern="$pattern" <<'SQL'
with invalidated as materialized (
  select source_hash from lean_check
  where source ~ :'pattern'
     or (outcome = 'failed' and detail::text like '%does not exist%')
), requeued as (
  update verification
     set outcome = 'pending',
         detail = (detail - 'check_hash') || '{"revalidating":true}'::jsonb,
         updated_at = now()
   where method = 'lean-kernel'
     and detail->>'check_hash' in (select source_hash from invalidated)
  returning contribution_id
), unreviewed as (
  update contribution
     set reviewed_at = null
   where reviewed_at is not null
     and id in (select contribution_id from requeued)
  returning id
), removed as (
  delete from lean_check
   where source_hash in (select source_hash from invalidated)
  returning source_hash
)
select source_hash from removed order by source_hash;
SQL
)

# The caller stops the verifier and runner before changing the installed
# library. Remove their queued files before starting them again, so no process
# can answer a new-toolchain question with work claimed under the old one.
spool=${LEAN_SPOOL_DIR:-/var/lib/lean-spool}
for hash in "${invalidated[@]}"; do
  rm -f "$spool/in/$hash.lean" "$spool/out/$hash.json"
done
printf 'requeued checks after %s changed: %d\n' "$prefix" "${#invalidated[@]}"
