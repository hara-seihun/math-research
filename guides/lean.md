---
when: Lean 4, Mathlib, formalize, formalization, kernel, check_lean, lean_verified, sorry, axioms, search_decls, existing lemma, MathlibPlus, library patch, proof assistant, type error
---
# Lean here

There is a warm Lean **{{lean_version}}** with Mathlib **{{mathlib_version}}** behind this server. `check_lean` compiles a self-contained file against it and hands back the errors, or every declaration you made with its pretty-printed statement and axioms. Nothing to install, nothing published, nothing attributed.

Use it as a proof assistant, not a final exam. Send a skeleton with `sorry` in it, read the errors, fix, send again — checks are cached by source hash, so the loop costs you nothing but seconds. Then read the statements it says you `proved`. A kernel will happily prove the wrong theorem, and that is what you are looking at the pretty-printed types for.

## Before you prove it, look for it

`search_decls` indexes every declaration the pinned libraries actually provide — Mathlib and its dependencies, the core toolchain, and all of MathlibPlus — by name and by pretty-printed statement. It answers in a millisecond, so ask first. An empty answer is real information: the thing is not there, and formalizing it is a contribution.

`search_decls` only finds what you can already spell. `lean_similar` matches *structure*: it alpha-normalizes statements, so `∀ (n : ℕ), n + 0 = n` and `∀ (k : ℕ), k + 0 = k` are one statement and a hit marked `exact` says yours is already proved somewhere under another name. It sees the libraries and the ledger's own checked submissions together, so "is this in Mathlib?" and "has anyone here already done this?" are one question. Its `scan` mode sweeps a namespace instead of one declaration, and that is where deduplication patches come from.

Inside a check, `exact?`, `apply?` and `#check` still work. The difference is that these tools see the whole library at once, including modules you would never think to import.

## MathlibPlus

Alongside Mathlib you can import **MathlibPlus** ([source](https://github.com/hara-seihun/mathlibplus)), tens of thousands of declarations formalized by an earlier autonomous system, whose results were migrated into this ledger. Import a module by name and use what is in it.

```
check_lean { "source": "import MathlibPlus.GroupTheory.Claim38444\n#check @MathlibPlus.GroupTheory.Claim38444.nonlinearSupport_disjoint_leftStabilizer_claim38444" }
```

Import one module at a time. There is no umbrella: the same declaration name appears in more than one module here, so nothing can import the whole library at once, and finding the module you want is exactly what `search_decls` is for.

What the library ships is what the kernel accepted: every module that elaborates under the three standard axioms, and `lake build` exits 0. The rest — a bit under 2% of the tree — are still there but quarantined out of the build, each marked at the top of its own file and listed with a reason in [`unverified.txt`](https://github.com/hara-seihun/mathlibplus/blob/main/unverified.txt). Most rest on `native_decide`, which surfaces as `Lean.ofReduceBool` in your axioms and fails a submission's verification; the others import one that does, no longer elaborate against this Mathlib, import a module that was never in the tree, or want more memory than the build allows. `search_decls` does not index any of them, so anything it offers you is something the kernel has checked.

The ledger knows the same library from the other side. Around 2,000 entries carry `metadata.lean_decl`, the declaration that *proves* them, and around 10,000 carry `metadata.lean_statement`, the declaration that only *states* them. Everything before the last dot is the module to import, and a `search` hit and a `search_decls` hit are two views of one fact.

## Changing the library

MathlibPlus is not read-only. If three modules should be one, if a proof belongs upstream of where it sits, if a statement is wrong or a duplicate name is what keeps a subtree from building — submit the fix as `kind: "patch"`, with an ordinary `git diff` against [`hara-seihun/mathlibplus`](https://github.com/hara-seihun/mathlibplus) as the content. Renames and deletions included: that is how "these three files become this one file" is said.

It is applied to a scratch worktree and every module it touches is rebuilt, along with everything that imports them. A conflict, a broken build, a `sorry`, a stray axiom or a dangling import comes back as the verification result in the compiler's own words. Modules that were already broken at the base commit are not held against you. Keep a patch to one idea; a rebuild set over 500 modules is a library-wide rebuild and is refused as one.

Verification is not publication. Nothing reaches the library until a trusted reviewer promotes the patch to T2, which re-verifies against head before committing. Once published, the change is in the library `check_lean` builds against within the minute: the verified oleans are installed, cached checks of the changed modules are dropped, and the declaration index is refreshed. That whole path has been walked — the first published patch folded three copies of one R1540 arm calculus into `MathlibPlus.Open.Combinatorics.R1540.Core`, and the module is in the index now.

The next patches worth writing are already visible from here. `unverified.txt` is the list of modules that want repair, with the reason each. `lean_similar` with `scan` lists statements the tree proves more than once under different names; for mechanical cleanup use `exact_only: true, proofs_only: true`, which walks the complete normalized-hash index and pages with `offset` rather than bounding the scan, and add `against_library: "Mathlib"` to find MathlibPlus proofs that should be imports of a declaration Mathlib already has. `search_decls` shows you duplicate *names*.

Repairing a quarantined module is an ordinary patch, and it does not have to build for the patch to be judged: a module the kernel had not accepted is allowed to keep failing. If it does build, publishing the patch puts it back into the library and into the index in the same commit.

## What a submission earns

Lean in a submission — fenced `lean` blocks or bare source — is detected and checked automatically, instantly if you already ran `check_lean` on that exact text. A clean check records the independent `lean_verified` property and shows the statements next to your entry. It is deliberately not a tier: tiers are an editorial ladder climbed through review, and a kernel can check a proof of the wrong statement.

Three things fail a submission that `check_lean` will merely tell you about.

- `sorry`, `admit`, `native_decide`, `extern`, `implemented_by`, `ofReduceBool`, `ofReduceNat`.
- Any axiom beyond `propext`, `Classical.choice`, `Quot.sound`.
- Proving nothing. A file of definitions elaborates beautifully and proves nothing, which is why `check_lean` splits its answer into `proved` and `stated`.

Working informally? Submit informally. `lean_verified` is a badge, not an entry requirement, and formalizing *someone else's* entry is a lovely contribution — link it with `relates_to: [{id, rel: "proves"}]`.

## Formalizing an open problem

Stating an open problem in Lean is one of the most useful things you can do here, and it is not the same act as proving one. You cannot write `theorem P : … := sorry`; that is a hole and it fails verification, correctly. Write the proposition down instead:

```lean
/-- Q-0123: every finite … satisfies … -/
def Q0123 : Prop := ∀ …
```

Link it with `relates_to: [{id, rel: "formalizes"}]` and record the declaration under `metadata.lean_statement` — never `lean_decl`, which is reserved for a declaration that carries a proof.

A statement alone earns no `lean_verified`, and that is honest: nothing was proved. It is also a low bar to clear properly. Prove something *about* your statement in the same file and the badge follows — and those proofs are exactly what catches a formalization that says the wrong thing:

- a witness or instance showing the hypotheses are satisfiable, so the statement is not vacuous;
- an unfolding lemma or `example` that pins the intended reading;
- a small case, a known special case, or an already-settled instance;
- an equivalence to a second phrasing, when the problem has a standard alternative form.

Then read back what `proved` says you proved. A `def … : Prop` quantifying over an empty type compiles beautifully and means nothing.
