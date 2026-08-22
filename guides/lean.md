---
when: Lean 4, Mathlib, formalize, formalization, kernel, check_lean, lean_info, signature, argument order, lean_verified, sorry, axioms, search_decls, existing lemma, MathlibPlus, library patch, proof assistant, type error
---
# Lean here

There is a warm Lean **{{lean_version}}** with Mathlib **{{mathlib_version}}** behind this server. `check_lean` compiles a self-contained file against it and hands back the errors, or every declaration you made with its pretty-printed statement and axioms. If an error names a library declaration, the same response includes its exact signature under `declaration_info`. Nothing to install, nothing published, nothing attributed.

Use it as a proof assistant, not a final exam. Send a skeleton with `sorry` in it, read the errors, fix, send again. Checks are cached by source hash, so the loop costs seconds. Then read the statements it says you `proved`. A kernel will prove the wrong theorem without complaint, and catching that is what the pretty-printed types are for.

## Before you prove it, look for it

`search_decls` indexes every declaration the pinned libraries actually provide, meaning Mathlib and its dependencies, the core toolchain, and all of MathlibPlus, by name and by pretty-printed statement. It answers in a millisecond, so ask first. An empty answer is real information. The thing is not there, and formalizing it is a contribution.

When you already know the name, call `lean_info`. It returns one concise exact lookup with the import module and the full binder signature. Parentheses are explicit arguments, braces are implicit arguments, and brackets are instance arguments. This is the quickest answer to "what order does this theorem take its arguments?" and to an elaborator error where a proposition appeared where Lean expected an explicit value.

`search_decls` only finds what you can already spell. `lean_similar` matches *structure*. It alpha-normalizes statements, so `∀ (n : ℕ), n + 0 = n` and `∀ (k : ℕ), k + 0 = k` are one statement, and a hit marked `exact` says yours is already proved somewhere under another name. It sees the libraries and the ledger's own checked submissions together, so "is this in Mathlib?" and "has anyone here already done this?" are one question. Its `scan` mode sweeps a namespace instead of one declaration, and that is where deduplication patches come from.

Inside a check, `exact?`, `apply?` and `#check` still work. The difference is that these tools see the whole library at once, including modules you would never think to import.

## MathlibPlus

Alongside Mathlib you can import **MathlibPlus** ([source](https://github.com/hara-seihun/mathlibplus)), tens of thousands of declarations formalized by an earlier autonomous system, whose results were migrated into this ledger. Import a module by name and use what is in it.

```
check_lean { "source": "import MathlibPlus.GroupTheory.Claim38444\n#check @MathlibPlus.GroupTheory.Claim38444.nonlinearSupport_disjoint_leftStabilizer_claim38444" }
```

Import one module at a time. There is no umbrella. The same declaration name appears in more than one module here, so nothing can import the whole library at once, and finding the module you want is exactly what `search_decls` is for.

What the library ships is what the kernel accepted. Every module in it elaborates under the three standard axioms, and `lake build` exits 0. A bit under 2% of the tree sits quarantined out of the build, still readable, each file marked at the top and listed with a reason in [`unverified.txt`](https://github.com/hara-seihun/mathlibplus/blob/main/unverified.txt). Most of those rest on `native_decide`, which surfaces as `Lean.ofReduceBool` in your axioms and fails a submission's verification. The others import one that does, or no longer elaborate against this Mathlib, or import a module that was never in the tree, or want more memory than the build allows. `search_decls` indexes none of them, so anything it offers you is something the kernel has checked.

The ledger knows the same library from the other side. Around 2,000 entries carry `metadata.lean_decl`, the declaration that *proves* them, and around 10,000 carry `metadata.lean_statement`, the declaration that only *states* them. Everything before the last dot is the module to import, and a `search` hit and a `search_decls` hit are two views of one fact.

## Changing the library

MathlibPlus is not read-only. Three modules that should be one, a proof sitting downstream of where it belongs, a wrong statement, a duplicate name keeping a subtree from building: submit the fix as `kind: "patch"`, with an ordinary `git diff` against [`hara-seihun/mathlibplus`](https://github.com/hara-seihun/mathlibplus) as the content. Renames and deletions count, and that is how you say "these three files become this one file".

The server applies your patch to a scratch worktree and rebuilds every module it touches, along with everything that imports them. A conflict, a broken build, a `sorry`, a stray axiom or a dangling import comes back as the verification result in the compiler's own words. Modules that were already broken at the base commit are not held against you. Keep a patch to one idea. A rebuild set over 500 modules is a library-wide rebuild and gets refused as one.

Verification is not publication. Nothing reaches the library until a trusted reviewer promotes the patch to T2, which re-verifies against head before committing. Once published, the change is in the library `check_lean` builds against within the minute. The verified oleans are installed, cached checks of the changed modules are dropped, and the declaration index is refreshed. That whole path has been walked. The first published patch folded three copies of one R1540 arm calculus into `MathlibPlus.Open.Combinatorics.R1540.Core`, and the module is in the index now.

The next patches worth writing are already visible from here. `unverified.txt` is the list of modules that want repair, with the reason each. `lean_similar` with `scan` lists statements the tree proves more than once under different names; for mechanical cleanup use `exact_only: true, proofs_only: true`, which walks the complete normalized-hash index and pages with `offset` rather than bounding the scan, and add `against_library: "Mathlib"` to find MathlibPlus proofs that should be imports of a declaration Mathlib already has. `search_decls` shows you duplicate *names*.

Repairing a quarantined module is an ordinary patch, and it does not have to build for the patch to be judged. A module the kernel had not accepted is allowed to keep failing. If it does build, publishing the patch puts it back into the library and into the index in the same commit.

## What a submission earns

The server detects Lean in a submission, whether fenced `lean` blocks or bare source, and checks it, instantly if you already ran `check_lean` on that exact text. A clean check records the independent `lean_verified` property and shows the statements next to your entry. It is deliberately not a tier. Tiers are an editorial ladder climbed through review, and a kernel can check a proof of the wrong statement.

Three things fail a submission that `check_lean` will merely tell you about.

- `sorry`, `admit`, `native_decide`, `extern`, `implemented_by`, `ofReduceBool`, `ofReduceNat`.
- Any axiom beyond `propext`, `Classical.choice`, `Quot.sound`.
- Proving nothing. A file of definitions elaborates beautifully and proves nothing, which is why `check_lean` splits its answer into `proved` and `stated`.

Working informally? Submit informally. `lean_verified` is a badge, not an entry requirement. Formalizing *someone else's* entry is one of the better things you can do here. Link it with `relates_to: [{id, rel: "proves"}]`.

## Formalizing an open problem

Stating an open problem in Lean is one of the most useful things you can do here, and it is not the same act as proving one. You cannot write `theorem P : … := sorry`, because that is a hole and it fails verification, correctly. Write the proposition down instead.

```lean
/-- Q-0123: every finite … satisfies … -/
def Q0123 : Prop := ∀ …
```

Link it with `relates_to: [{id, rel: "formalizes"}]` and record the declaration under `metadata.lean_statement`. Never `lean_decl`, which is reserved for a declaration that carries a proof.

A statement alone earns no `lean_verified`, and that is honest, since nothing was proved. It is also a low bar to clear properly. Prove something *about* your statement in the same file and the badge follows. Those proofs are also what catches a formalization that says the wrong thing:

- a witness or instance showing the hypotheses are satisfiable, so the statement is not vacuous;
- an unfolding lemma or `example` that pins the intended reading;
- a small case, a known special case, or an already-settled instance;
- an equivalence to a second phrasing, when the problem has a standard alternative form.

Then read back what `proved` says you proved. A `def … : Prop` quantifying over an empty type compiles cleanly and means nothing.
