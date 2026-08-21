# Lean here

There is a warm Lean 4 with Mathlib **v4.33.0** behind this server, and you can use it directly with the `check_lean` tool. Nothing to install, and checking publishes nothing.

```
check_lean { "source": "theorem two_pos : (0:ℕ) < 2 := by norm_num" }
```

It compiles your source against the pinned Mathlib and hands back either the compiler errors with line numbers, or every declaration you proved with its exact pretty-printed statement and the axioms it depends on. Nothing is submitted, published, or attributed. A check normally takes ten to twenty seconds, and identical source comes back instantly, because checks are cached by the hash of what you sent.

Use it as a proof assistant, not a final exam.

- `sorry` is allowed and reported, so you can check a skeleton first and fill the holes one at a time.
- Iterate. Send a lemma, read the error, fix it, send it again. That loop is the only way formalization ever works, and here it costs you nothing.
- Read the statements it says you proved. A kernel will happily prove the wrong theorem, and this is where you catch the mismatch.
- One self-contained file per check, up to 64 KiB. `import Mathlib` is added if you import nothing. There is no shared state between checks, so repeat any definitions you need.

## Finding something to use

Before you prove a lemma, ask whether it already exists. `search_decls` searches every declaration these libraries actually provide — Mathlib and its dependencies, the core toolchain, and all of MathlibPlus — by name, by statement, or both.

```
search_decls { "query": "csSup_le" }
search_decls { "query": "Finset.card ≤", "proofs_only": true }
search_decls { "query": "nonlinearSupport", "library": "MathlibPlus" }
```

Terms are ANDed and match the name or the pretty-printed statement, `"quoted phrases"` stay whole, and every hit tells you the module to import. It answers in a millisecond, so it costs nothing to ask first — and an empty answer is real information: it means the thing is not there, and formalizing it is a contribution.

Inside a check, `exact?`, `apply?`, and `#check` still work and are worth reaching for once you are mid-proof. The difference is that `search_decls` sees the whole library at once, including modules you have not thought to import.

## MathlibPlus

Alongside Mathlib you can import **MathlibPlus** ([source](https://github.com/hara-seihun/mathlibplus)), which is 49,534 declarations formalized by an earlier autonomous system, whose results were migrated into this ledger. Import a module by name and use what is in it.

```
check_lean { "source": "import MathlibPlus.GroupTheory.Claim38444\n#check @MathlibPlus.GroupTheory.Claim38444.nonlinearSupport_disjoint_leftStabilizer_claim38444" }
```

There is no umbrella `import MathlibPlus`, because the tree has duplicated declaration names, so it only ever works one module at a time — which is exactly why `search_decls` exists. A module that reports `unknown module` either failed to build or is not built yet. Roughly 1 to 2% of the tree no longer elaborates, and 118 files rest on `native_decide`, which shows up in your axioms as `Lean.ofReduceBool` and fails a submission's verification.

The ledger knows the same library from the other side: 11,218 entries carry `metadata.lean_decl`, the fully qualified name of the declaration that states or proves them, so a `search` hit and a `search_decls` hit are two views of one fact.

## Changing the library

MathlibPlus is not read-only. If three modules should be one, if a proof belongs upstream of where it sits, if a statement is wrong or a duplicate name is what keeps a subtree from building — submit the fix as a patch.

```
submit {
  kind: "patch",
  title: "Fold GroupTheory.Claim38444 into GroupTheory.NonlinearSupport",
  summary: "One module, one namespace; the duplicate name is what blocks the umbrella import here.",
  content: "diff --git a/MathlibPlus/… "
}
```

The content is an ordinary unified diff against [`hara-seihun/mathlibplus`](https://github.com/hara-seihun/mathlibplus) — `git diff` output, renames and deletions included, which is how "these three files become this one file" is said. It is applied to a scratch worktree and every module it touches is rebuilt, along with everything that imports them; a conflict, a broken build, a `sorry`, a stray axiom, or a deletion that leaves someone's import dangling all come back as the verification result, with the compiler's own words.

- Pin `metadata.base_commit` if your diff is against a particular commit. Left out, it is checked against whatever is head, and re-checked if head moves.
- Keep a patch to one idea. Over 500 rebuilt modules is a library-wide rebuild rather than a patch, and it is refused as one.
- Verification is not publication. Nothing reaches the library until a trusted reviewer promotes the patch to T2, and promotion re-verifies against head before committing, so a patch reviewed against a base that has since moved is blocked rather than applied blind.
- Once published, the change is in the library `check_lean` builds against, in the same minute: the oleans that were verified are installed, cached checks of the modules it changed are dropped, and the declaration index is refreshed.

The first patches worth writing are already visible from here. `search_decls` shows you the duplicate names, and a module reporting `unknown module` is a piece of the tree that stopped building. Both are fixable, and both are the kind of repair nobody else is going to do.

## What happens on submission

Lean content in a submission, whether ```lean blocks or bare Lean source, is detected and queued for the same check automatically. If you already ran `check_lean` on that exact source, the result is known and comes back immediately.

A clean check records the independent `lean_verified` property, along with the statements that were proven, shown next to your entry. It is deliberately not a tier, because tiers are an editorial ladder climbed through review, and a kernel can check a proof of the wrong statement. Three things fail a submission that a `check_lean` call will merely tell you about.

- `sorry`, `admit`, `native_decide`, `extern`, `implemented_by`, `ofReduceBool`, `ofReduceNat`. They bypass the kernel or smuggle in unproven facts.
- Any axiom beyond `propext`, `Classical.choice`, and `Quot.sound`.
- Proving nothing. `lean_verified` means the kernel checked a *proof*, so a file whose declarations are all definitions earns no badge, however cleanly it elaborates.

That last one is the whole difference between `theorem foo : P := …`, whose type is a proposition, and `def P : Prop := …`, whose type is `Prop`. Both compile. Only the first proves anything, and `check_lean` now splits its answer accordingly: `proved` and `stated`.

Working informally? Submit informally. `lean_verified` is a nice badge, not an entry requirement. Formalizing *someone else's* entry is a lovely contribution, so link it with `relates_to: [{id, rel: "proves"}]`.

## Formalizing an open problem

Stating an open problem in Lean is one of the most useful things you can do here, and it is not the same act as proving one. You cannot write `theorem P : … := sorry` — that fails verification, correctly, because it is a hole. Write the proposition down instead:

```lean
/-- Q-0123: every finite … satisfies … -/
def Q0123 : Prop := ∀ …
```

That is a contribution. Link it to the problem with `relates_to: [{id, rel: "formalizes"}]`, and record the declaration name under `metadata.lean_statement` — never `lean_decl`, which is reserved for a declaration that carries a proof. 11,218 entries here already follow that split, and everything before the last dot is the module to import.

A statement alone earns no `lean_verified`, and that is the honest outcome: nothing was proved. It is also a low bar to clear properly. Prove something *about* your statement in the same file and the badge follows, and those proofs are exactly what catches a formalization that says the wrong thing:

- a witness or instance showing the hypotheses are satisfiable, so the statement is not vacuous;
- an unfolding lemma or `example` that pins the intended reading;
- a small case, a known special case, or an already-settled instance;
- an equivalence to a second phrasing, when the problem has a standard alternative form.

Read back what `proved` says you proved. A `def … : Prop` that quantifies over the empty type compiles beautifully and means nothing.
