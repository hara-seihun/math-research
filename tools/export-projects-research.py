#!/usr/bin/env python3
"""Export the Projects Research ledger as math-research import JSONL.

Tier mapping is mechanical, from adjudication state already recorded in the
ledger — no re-review. Tiers are review state only (T2 = accepted as canon);
kernel verification is the independent lean_verified property:
  admitted claim                       -> kind result,  tier 2
  admitted claim w/ reviewed alignment -> kind result,  tier 2 + lean-kernel verification record
  open obligation                      -> kind problem, tier 2

Usage: export-projects-research.py LEDGER.sqlite3 OUTDIR
"""
import json
import sqlite3
import sys
from pathlib import Path

ledger, outdir = sys.argv[1], Path(sys.argv[2])
outdir.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(f"file:{ledger}?mode=ro", uri=True)
db.row_factory = sqlite3.Row


def title_of(statement: str) -> str:
    line = " ".join(statement.split())
    return line if len(line) <= 140 else line[:139].rsplit(" ", 1)[0] + "…"


claims = {}
with open(outdir / "contributions.jsonl", "w") as out:
    reviewed = {
        r["claim_id"]: r["decl_name"]
        for r in db.execute(
            "select claim_id, decl_name from alignment where reviewed = 1"
        )
    }
    for row in db.execute(
        "select id, statement, provenance_hash, locator, created_at, adjudicated_at"
        " from claim where status = 'admitted' order by id"
    ):
        decl = reviewed.get(row["id"])
        key = f"claim:{row['id']}"
        claims[key] = True
        out.write(
            json.dumps(
                {
                    "import_key": key,
                    "kind": "result",
                    "title": title_of(row["statement"]),
                    "summary": " ".join(row["statement"].split())[:2000],
                    "content": row["statement"],
                    "tier": 2,
                    "created_at": row["created_at"],
                    "metadata": {
                        "imported_from": "projects-research",
                        "claim_id": row["id"],
                        **({"lean_decl": decl} if decl else {}),
                        **(
                            {"provenance_hash": row["provenance_hash"]}
                            if row["provenance_hash"]
                            else {}
                        ),
                        **({"locator": row["locator"]} if row["locator"] else {}),
                    },
                }
            )
            + "\n"
        )

    retired = {
        r["obligation_id"]
        for r in db.execute("select obligation_id from obligation_retirement")
    }
    answered = {
        r["dst_id"]
        for r in db.execute(
            "select dst_id from edge where dst_type = 'obligation' and kind = 'answers'"
        )
    }
    for row in db.execute(
        "select id, handle, exact_scope, created_at from obligation"
        " where obligation_kind = 'research' order by id"
    ):
        if row["id"] in retired or row["id"] in answered:
            continue
        key = f"obligation:{row['id']}"
        claims[key] = True
        out.write(
            json.dumps(
                {
                    "import_key": key,
                    "kind": "problem",
                    "title": row["handle"],
                    "summary": " ".join(row["exact_scope"].split())[:2000],
                    "content": row["exact_scope"],
                    "tier": 2,
                    "created_at": row["created_at"],
                    "metadata": {
                        "imported_from": "projects-research",
                        "obligation_id": row["id"],
                        "handle": row["handle"],
                    },
                }
            )
            + "\n"
        )

edge_count = 0
with open(outdir / "edges.jsonl", "w") as out:
    for row in db.execute(
        "select src_type, src_id, dst_type, dst_id, kind, note from edge"
        " where src_type in ('claim','obligation') and dst_type in ('claim','obligation')"
    ):
        src = f"{row['src_type']}:{row['src_id']}"
        dst = f"{row['dst_type']}:{row['dst_id']}"
        if src in claims and dst in claims and src != dst:
            out.write(
                json.dumps(
                    {"src": src, "dst": dst, "rel": row["kind"], "note": row["note"]}
                )
                + "\n"
            )
            edge_count += 1

print(f"exported {len(claims)} contributions, {edge_count} edges to {outdir}")
