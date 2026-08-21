#!/usr/bin/env python3
"""Export the frozen Projects Research ledger as math-research import JSONL.

The predecessor's ontology is preserved rather than flattened. Every work item
keeps the type and lifecycle position it actually had, so questions like "which
cells of this classification are closed?" stay answerable on the other side:

  research programme (program_handle)     -> front            (tier 2)
  research obligation / classification    -> problem          (tier 2) + state
  open formal registry node (Lean Prop)   -> problem          (tier 2) + lean decl
  distilled attack route                  -> route            (tier 2) + state
  research write-up (source record)       -> result           (tier by standing)
  admitted claim extracted from a write-up-> statement        (tier 2)
  frontier intake adjudication            -> review           (tier 2)
  completed attack with no surviving thm  -> trail (closed)

Tiers stay mechanical, read off adjudication state already in the ledger; no
re-review happens here. Kernel verification is exported as the independent
lean_verified property, never as a tier.

Usage: export-projects-research.py LEDGER.sqlite3 OUTDIR [EVIDENCE_DIR]
"""
import json
import re
import sqlite3
import sys
from pathlib import Path

ledger, outdir = sys.argv[1], Path(sys.argv[2])
evidence = Path(sys.argv[3] if len(sys.argv) > 3 else Path(ledger).parent / "evidence")
outdir.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(f"file:{ledger}?mode=ro", uri=True)
db.row_factory = sqlite3.Row

ONTOLOGY = Path(__file__).resolve().parent.parent.parent.parent / "projects-research" / "ontology" / "obligations"

# ——— Titles ————————————————————————————————————————————————————————————
# The predecessor named work items with slugs ("hara-asked-on-at-highest-…")
# and 140-character statement prefixes cut mid-sentence. Neither is a title a
# reader can scan, so titles are rebuilt here from the first real sentence of
# the statement and the slug is kept as a searchable alias instead.

_ABBREV = re.compile(r"(?:^|\s)(?:e\.g|i\.e|cf|resp|vs|Fig|Thm|Def|no|approx|w\.r\.t)\.$", re.I)


# Markdown decoration that is layout, not title: fences, heading marks, list
# bullets, emphasis. A title cut straight from a write-up otherwise starts
# "### R-4464.7 —" or, worse, "```text".
# Write-ups are hard-wrapped, so the first *line* is a fragment ("…minimal in")
# and the sentence continues on the next one. Titles are cut from the first
# paragraph instead, with markdown scaffolding — fences, heading marks, list
# bullets, emphasis — removed line by line.
_FENCE = re.compile(r"^```")


def headline(text: str) -> str:
    """The first paragraph of prose, unwrapped, with markdown removed."""
    para: list[str] = []
    fenced = False
    for raw in (text or "").splitlines():
        stripped = raw.strip()
        if _FENCE.match(stripped):
            if para:
                break
            fenced = not fenced
            continue
        if not stripped:
            if para:
                break
            continue
        if fenced:
            para.append(stripped)
            continue
        heading = stripped.startswith("#")
        line = re.sub(r"^\s*(#{1,6}|[-*+]|\d+[.)])\s+", "", stripped)
        line = re.sub(r"\*\*(.+?)\*\*", r"\1", line)
        line = line.strip("*_ \t")
        # A backtick pair around the whole line is decoration; a leading
        # backtick that opens inline code (`n`, and both …) is not.
        if line.startswith("`") and line.endswith("`"):
            line = line.strip("` \t")
        if line:
            para.append(line)
        if heading:
            break
    return " ".join(para)


def first_sentence(text: str, limit: int = 160) -> str:
    line = " ".join(headline(text).split())
    if not line:
        return ""
    out = []
    depth = 0
    for i, ch in enumerate(line):
        out.append(ch)
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        if depth == 0 and ch in ".;:" and i + 1 < len(line) and line[i + 1] == " ":
            head = "".join(out)
            if _ABBREV.search(head) or head.rstrip(".;: ").endswith("\\"):
                continue
            if len(head) >= 40:
                return head.rstrip(".;: ")
    return "".join(out)


def title_of(text: str, limit: int = 160) -> str:
    """A scannable title: first sentence, never cut mid-word, never mid-formula."""
    line = first_sentence(text, limit)
    if len(line) <= limit:
        return line or "untitled"
    cut = line[:limit]
    # Never end inside a $…$ or \[…\] run: back off to the last safe boundary.
    if cut.count("$") % 2:
        cut = cut[: cut.rfind("$")]
    head = cut.rsplit(" ", 1)[0].rstrip(",;:. ")
    return (head or line[:limit]) + "…"


def clean(text: str, limit: int) -> str:
    line = " ".join((text or "").split())
    return line if len(line) <= limit else line[: limit - 1].rsplit(" ", 1)[0] + "…"


def slug_words(handle: str) -> str:
    return " ".join(handle.split("-"))


# ——— Evidence bodies ———————————————————————————————————————————————————
FRONTMATTER = re.compile(r"\A---\n.*?\n---\n", re.S)

_object_of = {
    r["locator"]: r["storage_path"]
    for r in db.execute(
        "select eo.locator, o.storage_path from evidence_origin eo"
        " join evidence_object o on o.sha256 = eo.sha256"
    )
}


def body_for(source_path: str | None) -> str | None:
    path = _object_of.get(source_path or "")
    if not path:
        return None
    try:
        raw = (evidence / path).read_text(errors="replace")
    except OSError:
        return None
    return FRONTMATTER.sub("", raw).strip() or None


contributions: list[dict] = []
edges: list[dict] = []
trails: list[dict] = []
exported: set[str] = set()


def emit(record: dict) -> None:
    exported.add(record["import_key"])
    contributions.append(record)


def link(src: str, dst: str, rel: str, note: str | None = None, tier: int = 2) -> None:
    edges.append({"src": src, "dst": dst, "rel": rel, "note": note, "tier": tier})


# ——— Programmes -> fronts ——————————————————————————————————————————————
manifest_of: dict[str, dict] = {}
if ONTOLOGY.is_dir():
    for path in sorted(ONTOLOGY.glob("*.json")):
        data = json.loads(path.read_text())
        handle = data.get("program", {}).get("handle")
        if handle:
            manifest_of[handle] = data

obligations = {r["id"]: dict(r) for r in db.execute("select * from obligation")}
retired = {
    r["obligation_id"]: dict(r) for r in db.execute("select * from obligation_retirement")
}
answered = {
    r["dst_id"]
    for r in db.execute(
        "select distinct e.dst_id from edge e join claim c on c.id = e.src_id"
        " where e.dst_type = 'obligation' and e.src_type = 'claim' and e.kind = 'answers'"
        "   and c.status = 'admitted'"
    )
}
obligation_aliases: dict[int, list[str]] = {}
for r in db.execute("select obligation_id, alias from obligation_alias"):
    obligation_aliases.setdefault(r["obligation_id"], []).append(r["alias"])

by_program: dict[str, list[dict]] = {}
for ob in obligations.values():
    by_program.setdefault(ob["program_handle"], []).append(ob)

root_of = {ob["handle"]: ob for ob in obligations.values()}

front_key: dict[str, str] = {}
for program, members in by_program.items():
    manifest = manifest_of.get(program)
    if len(members) < 2 and not manifest:
        continue  # a one-obligation "programme" is just that obligation
    root = root_of.get(program)
    scope = (manifest or {}).get("program", {}).get("scope") or (root or {}).get("exact_scope") or slug_words(program)
    aliases = list((manifest or {}).get("program", {}).get("aliases") or [])
    key = f"program:{program}"
    front_key[program] = key
    # A programme's reviewed alias is a real name; prefer it over the first
    # sentence of a scope paragraph, which reads as a task, not a heading.
    named = max(aliases, key=len) if aliases else None
    emit(
        {
            "import_key": key,
            "kind": "front",
            "title": named[0].upper() + named[1:] if named else title_of(scope, 120),
            "summary": clean(scope, 1200),
            "content": scope,
            "tier": 2,
            "names": [program] + aliases,
            "created_at": min(m["created_at"] for m in members),
            "metadata": {
                "imported_from": "projects-research",
                "program_handle": program,
                "campaign": bool(manifest),
                **({"manifest": f"ontology/obligations/{program}.json"} if manifest else {}),
            },
        }
    )

# ——— Obligations -> problems ———————————————————————————————————————————
for ob in obligations.values():
    key = f"obligation:{ob['id']}"
    aliases = obligation_aliases.get(ob["id"], [])
    emit(
        {
            "import_key": key,
            "kind": "problem",
            "title": title_of(ob["exact_scope"]),
            "summary": clean(ob["exact_scope"], 2000),
            "content": ob["exact_scope"],
            "tier": 2,
            "status": "retracted" if ob["id"] in retired else "active",
            "names": [ob["handle"]] + aliases,
            "created_at": ob["created_at"],
            "metadata": {
                "imported_from": "projects-research",
                "obligation_id": ob["id"],
                "handle": ob["handle"],
                "work_kind": ob["obligation_kind"],
                **({"program_handle": ob["program_handle"]} if ob["program_handle"] else {}),
                **({"source_locator": ob["source_locator"]} if ob["source_locator"] else {}),
                **(
                    {"retired_because": retired[ob["id"]]["reason"]}
                    if ob["id"] in retired
                    else {}
                ),
            },
        }
    )
    front = front_key.get(ob["program_handle"])
    if front and ob["handle"] != ob["program_handle"]:
        link(key, front, "in-front", "programme member")

for r in db.execute("select * from obligation_dependency"):
    link(
        f"obligation:{r['obligation_id']}",
        f"obligation:{r['depends_on_id']}",
        "depends-on",
        r["evidence"],
    )
for r in db.execute("select * from obligation_replacement"):
    link(
        f"obligation:{r['replacement_obligation_id']}",
        f"obligation:{r['obligation_id']}",
        "supersedes",
        r["reason"],
    )

# ——— Formal open registry (Lean Props) —————————————————————————————————
# The predecessor kept informal obligations and formal Lean `Prop`s in separate
# tables with nothing joining them, so the same question could appear twice
# with no way to tell. Where the formal gloss is word-for-word an obligation's
# scope, they are one question in two languages; say so with an edge rather
# than silently showing a reader two problems.
def fold(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


scope_key = {}
for ob in obligations.values():
    key = f"obligation:{ob['id']}"
    scope_key.setdefault(fold(ob["exact_scope"]), key)
    scope_key.setdefault(fold(title_of(ob["exact_scope"])), key)

for r in db.execute("select * from node"):
    key = f"node:{r['id']}"
    gloss = r["informal"] or slug_words(r["decl_name"].split(".")[-1])
    # Registry glosses are written "short name: full statement"; the short name
    # is the title the author already chose.
    head = gloss.split(": ", 1)[0]
    named = head if len(head) <= 90 and ". " not in head else None
    lean = f"```lean\n{r['statement_src']}\n```"
    emit(
        {
            "import_key": key,
            "kind": "problem",
            "title": (named[0].upper() + named[1:]) if named else title_of(gloss),
            "summary": clean(gloss, 2000),
            "content": f"{gloss}\n\nFormal statement (Lean 4 / Mathlib v4.33.0, kernel-elaborated as an open `Prop`):\n\n{lean}",
            "tier": 2,
            "names": [r["decl_name"], r["decl_name"].split(".")[-1]],
            "created_at": r["created_at"],
            "metadata": {
                "imported_from": "projects-research",
                "node_id": r["id"],
                "lean_decl": r["decl_name"],
                "registry_status": r["status"],
                "root_problem": bool(r["is_root"]),
                **({"resolved_by": r["resolved_by"]} if r["resolved_by"] else {}),
            },
        }
    )
    twin = scope_key.get(fold(gloss)) or scope_key.get(fold(title_of(gloss)))
    if twin:
        link(key, twin, "equivalent-to", "formal Lean statement of the same question")
    # A resolved registry entry names the Lean theorem that settled it. Record
    # that theorem as an entry of its own so the question is settled by
    # something in the graph, the way every other settled question is.
    if r["resolved_by"]:
        proof_key = f"node-proof:{r['id']}"
        verdict = "disproves" if r["status"] == "disproved" else "proves"
        emit(
            {
                "import_key": proof_key,
                "kind": "theorem",
                "title": title_of(f"{'Refutation' if verdict == 'disproves' else 'Proof'} of {named or gloss}"),
                "summary": clean(
                    f"Kernel-checked Lean theorem `{r['resolved_by']}` {verdict.replace('s', 's')} the registry statement `{r['decl_name']}`.",
                    2000,
                ),
                "content": f"Lean 4 / Mathlib v4.33.0 declaration that settles `{r['decl_name']}`:\n\n```lean\n{r['resolved_by']}\n```\n\nStatement settled:\n\n```lean\n{r['statement_src']}\n```",
                "tier": 2,
                "names": [r["resolved_by"], r["resolved_by"].split(".")[-1]],
                "created_at": r["created_at"],
                "metadata": {
                    "imported_from": "projects-research",
                    "node_id": r["id"],
                    "lean_decl": r["resolved_by"],
                    "settles": r["decl_name"],
                },
            }
        )
        link(proof_key, key, verdict, f"kernel-checked as {r['resolved_by']}")

for r in db.execute("select * from node_alt"):
    link(f"node:{r['node_id']}", f"node:{r['node_id']}", "equivalent-to", r["decl_name"])
edges = [e for e in edges if e["src"] != e["dst"]]

# ——— Research write-ups -> results, and their claims -> statements ————————
doc_of_claim: dict[int, int] = {}
for r in db.execute(
    "select claim_id, source_record_id, role from claim_source"
    " where role in ('section', 'reviewed-frontier-statement', 'reconciled')"
):
    doc_of_claim.setdefault(r["claim_id"], r["source_record_id"])

STANDING_TIER = {"accepted": 2, "provisional": 1, "open": 1, "superseded": 2, "refuted": 0}
STANDING_STATUS = {"refuted": "retracted", "superseded": "superseded"}

for r in db.execute("select * from source_record"):
    meta = json.loads(r["metadata_json"]) if r["metadata_json"] else {}
    key = f"source:{r['id']}"
    body = body_for(r["source_path"])
    if meta:
        title = meta.get("title") or r["title"] or clean(meta.get("statement", ""), 160)
        statement = meta.get("statement") or ""
        standing = meta.get("standing") or r["standing"] or "provisional"
        emit(
            {
                "import_key": key,
                "kind": "result",
                "title": title_of(title),
                "summary": clean(statement or title, 2000),
                "content": body or statement or title,
                "tier": STANDING_TIER.get(standing, 1),
                "status": STANDING_STATUS.get(standing, "active"),
                "names": list(meta.get("aliases") or []),
                "created_at": r["created_at"],
                "metadata": {
                    "imported_from": "projects-research",
                    "source_record_id": r["id"],
                    "locator": r["locator"],
                    "standing": standing,
                    **{
                        k: meta[k]
                        for k in ("family", "provenance", "roles", "tags", "surprise", "reach", "caveats", "problem")
                        if meta.get(k) not in (None, "", [], {})
                    },
                },
            }
        )
    elif r["note"]:
        # A frontier-intake adjudication: why an artifact did or did not become
        # a claim. Not a result — a review, and a genuinely useful one.
        stem = Path(r["source_path"] or r["locator"]).stem
        emit(
            {
                "import_key": key,
                "kind": "review",
                "title": title_of("Intake adjudication: " + slug_words(re.sub(r"-[0-9a-f-]{8,}$", "", stem))),
                "summary": clean(r["note"], 2000),
                "content": r["note"],
                "tier": 2,
                "created_at": r["created_at"],
                "metadata": {
                    "imported_from": "projects-research",
                    "source_record_id": r["id"],
                    "locator": r["locator"],
                    "disposition": r["disposition"],
                },
            }
        )

reviewed_alignment = {
    r["claim_id"]: r["decl_name"]
    for r in db.execute(
        "select a.claim_id, a.decl_name from alignment a where a.reviewed = 1"
        " and not exists (select 1 from alignment_invalidation i where i.alignment_id = a.id)"
    )
}

for r in db.execute(
    "select id, statement, provenance_hash, locator, created_at from claim"
    " where status = 'admitted' order by id"
):
    key = f"claim:{r['id']}"
    decl = reviewed_alignment.get(r["id"])
    emit(
        {
            "import_key": key,
            "kind": "statement",
            "title": title_of(r["statement"]),
            "summary": clean(r["statement"], 2000),
            "content": r["statement"],
            "tier": 2,
            "created_at": r["created_at"],
            "metadata": {
                "imported_from": "projects-research",
                "claim_id": r["id"],
                **({"lean_decl": decl} if decl else {}),
                **({"provenance_hash": r["provenance_hash"]} if r["provenance_hash"] else {}),
                **({"locator": r["locator"]} if r["locator"] else {}),
            },
        }
    )
    doc = doc_of_claim.get(r["id"])
    if doc is not None and f"source:{doc}" in exported:
        link(key, f"source:{doc}", "part-of", "extracted statement of this write-up")

# ——— Distilled attack routes ———————————————————————————————————————————
for r in db.execute("select * from obligation_route"):
    key = f"route:{r['id']}"
    target = f"obligation:{r['obligation_id']}"
    if target not in exported:
        continue
    unsupported = r["first_unsupported"]
    emit(
        {
            "import_key": key,
            "kind": "route",
            "title": title_of(f"{slug_words(r['name'])}: {first_sentence(r['summary'])}"),
            "summary": clean(r["summary"], 2000),
            "content": r["summary"]
            + (f"\n\n**First unsupported step.** {unsupported}" if unsupported else ""),
            "tier": 2,
            "state": r["status"],
            "names": [r["name"]],
            "created_at": r["created_at"],
            "metadata": {
                "imported_from": "projects-research",
                "route_id": r["id"],
                "route_name": r["name"],
                "route_status": r["status"],
                **({"first_unsupported": unsupported} if unsupported else {}),
                **({"lean_decl": r["decl_name"]} if r["decl_name"] else {}),
                **({"artifact_path": r["artifact_path"]} if r["artifact_path"] else {}),
            },
        }
    )
    link(key, target, "attacks", f"route {r['name']} ({r['status']})")
    if r["result_claim_id"] and f"claim:{r['result_claim_id']}" in exported:
        link(key, f"claim:{r['result_claim_id']}", "uses", "route result")

# ——— Typed edges already in the ledger —————————————————————————————————
# One batch of them asserts nothing. On 2026-08-14 19:02:52 the predecessor's
# `nr2-link` pass went through edges whose destination no longer resolved and
# wrote a *single constant* destination onto all 2,642 of them — Lean registry
# node 229, "Cell X1" — carrying one boilerplate note copied from the one edge
# it had actually reasoned about ("legacy answers edge Q-0089 <- R-2700").
# Nothing in the frozen ledger records what those edges were meant to point at,
# and their pre-repair destinations were already malformed, so there is nothing
# to re-derive: 1,981 unrelated statements "duplicate-of" one CI cell, 360
# "overlaps" it, and a stray "resolves" would derive `settled` for a question
# the predecessor still has open. Six were later repaired by hand
# (`edge_correction`, applied in place) and now carry real destinations and
# their own notes, so the note marker names exactly the unrepaired remainder.
NR2_CONSTANT_DST = "repaired from malformed obligation destination by nr2-link"

TYPE_KEY = {"claim": "claim", "obligation": "obligation", "node": "node"}
dropped_nr2 = 0
for r in db.execute("select src_type, src_id, dst_type, dst_id, kind, note from edge"):
    src_t, dst_t = TYPE_KEY.get(r["src_type"]), TYPE_KEY.get(r["dst_type"])
    if not src_t or not dst_t:
        continue
    if r["note"] and NR2_CONSTANT_DST in r["note"]:
        dropped_nr2 += 1
        continue
    src, dst = f"{src_t}:{r['src_id']}", f"{dst_t}:{r['dst_id']}"
    if src in exported and dst in exported and src != dst:
        link(src, dst, r["kind"], r["note"])

# ——— Completed attacks with no surviving theorem -> closed trails ————————
lease_obligation = {
    r["id"]: r["obligation_id"] for r in db.execute("select id, obligation_id from research_lease")
}
for r in db.execute(
    "select a.*, l.lane, l.worker, l.outcome from research_attempt a"
    " join research_lease l on l.id = a.lease_id"
):
    target = f"obligation:{lease_obligation.get(r['lease_id'])}"
    if target not in exported:
        continue
    notes = [r["summary"]]
    if r["first_unsupported"]:
        notes.append(f"First unsupported step: {r['first_unsupported']}")
    for d in json.loads(r["discoveries_json"] or "[]"):
        notes.append(f"Discovery: {d if isinstance(d, str) else json.dumps(d)}")
    trails.append(
        {
            "import_key": f"attempt:{r['lease_id']}",
            "title": title_of(f"{slug_words(r['lane'])}: {first_sentence(r['summary'])}", 140),
            "created_at": r["created_at"],
            "outcome": r["outcome"],
            "about": [target],
            "notes": notes,
        }
    )

with open(outdir / "contributions.jsonl", "w") as out:
    for record in contributions:
        out.write(json.dumps(record) + "\n")
with open(outdir / "edges.jsonl", "w") as out:
    for e in edges:
        if e["src"] in exported and e["dst"] in exported:
            out.write(json.dumps(e) + "\n")
with open(outdir / "trails.jsonl", "w") as out:
    for t in trails:
        out.write(json.dumps(t) + "\n")

kinds: dict[str, int] = {}
for c in contributions:
    kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
print(f"contributions: {len(contributions)} ({kinds})")
print(f"edges: {sum(1 for e in edges if e['src'] in exported and e['dst'] in exported)}")
print(f"edges dropped (nr2-link constant destination): {dropped_nr2}")
print(f"trails: {len(trails)}")
