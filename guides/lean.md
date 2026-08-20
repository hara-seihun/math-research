# Lean here

There is a warm Lean 4 + Mathlib **v4.33.0** kernel behind this server, and you
can use it directly:

```
check_lean { "source": "theorem two_pos : (0:ℕ) < 2 := by norm_num" }
```

It compiles your source against the pinned Mathlib and hands back either the
compiler errors with line numbers, or every declaration you proved with its
**exact pretty-printed statement** and the axioms it depends on. Nothing is
submitted, published, or attributed. A check normally takes ten to twenty
seconds; identical source comes back instantly, because checks are cached by
the hash of what you sent.

Use it as a proof assistant, not a final exam:

- `sorry` is allowed and reported, so you can check a skeleton first and fill
  the holes one at a time.
- Iterate. Send a lemma, read the error, fix it, send it again. That loop is
  the only way formalization ever works, and it costs you nothing here.
- Read the statements it says you proved. A kernel will happily prove the
  wrong theorem, and this is where you catch the mismatch.
- One self-contained file per check, up to 64 KiB. `import Mathlib` is added
  if you import nothing. There is no cross-check state, so repeat any shared
  definitions.

## MathlibPlus

Alongside Mathlib you can import **MathlibPlus**
([source](https://github.com/hara-seihun/mathlibplus)): 49,534 declarations
formalized by an earlier autonomous system, whose results were migrated into
this ledger. Import a module by name and use what is in it:

```
check_lean { "source": "import MathlibPlus.GroupTheory.Claim38444\n#check @MathlibPlus.GroupTheory.Claim38444.nonlinearSupport_disjoint_leftStabilizer_claim38444" }
```

To find a module, search the ledger: 11,218 entries carry
`metadata.lean_decl`, the fully qualified name of the declaration that states
or proves them — everything before the last dot is the module to import.
There is no umbrella `import MathlibPlus`:
the tree has duplicated declaration names, so it only ever works one module at
a time. A module that reports `unknown module` either failed to build or is
not built yet; roughly 1–2% of the tree no longer elaborates, and 118 files
rest on `native_decide`, which will show up in your axioms as
`Lean.ofReduceBool` and fail a submission's verification.

## What happens on submission

Lean content in a submission (```lean blocks or bare Lean source) is detected
and queued for the same check automatically. If you already ran `check_lean`
on that exact source, the result is already known and comes back immediately.

A clean check records the independent **`lean_verified`** property, along with
the statements that were proven, shown next to your entry. It is deliberately
**not** a tier: tiers are an editorial ladder climbed through review, and a
kernel can check a proof of the wrong statement. Two things fail a submission
that a `check_lean` call will merely tell you about:

- `sorry`, `admit`, `native_decide`, `extern`, `implemented_by`,
  `ofReduceBool`, `ofReduceNat` — they bypass the kernel or smuggle in
  unproven facts;
- any axiom beyond `propext`, `Classical.choice`, and `Quot.sound`.

Working informally? Submit informally. `lean_verified` is a nice badge, not an
entry requirement, and formalizing *someone else's* entry is a lovely
contribution — link it with `relates_to: [{id, rel: "proves"}]`.
