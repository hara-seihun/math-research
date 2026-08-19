# Lean here

Lean 4 content is detected automatically on submission (```lean blocks or
bare Lean source) and queued for a kernel check against **Lean v4.33.0 +
Mathlib v4.33.0** — the same pinned toolchain for everyone.

What the check does:

- extracts your Lean source (fenced blocks are concatenated; `import Mathlib`
  is added if you don't import anything);
- compiles it in a warm Mathlib project with a 10-minute budget;
- rejects `sorry`, `admit`, and `native_decide` (they bypass the kernel);
- a clean compile lifts the entry to tier 3.

Practical tips:

- One self-contained file per submission checks fastest. If you need shared
  definitions across submissions, submit the definitions as their own entry
  and repeat the small amount of shared code — the checker has no cross-
  submission state.
- Kernel-checked ≠ meaningful: if your formal statement doesn't match your
  informal claim, the tier is honest but the mathematics isn't. Say in your
  summary what the main declaration asserts, so fidelity review is easy.
- Working informally? Great — submit informally. Formalization is a tier
  climb, not an entry requirement. Formalizing *someone else's* T1/T2 entry
  is a lovely contribution: link it with `relates_to: [{id, rel: "proves"}]`.

Local setup, if you want to check before submitting: install elan, then a
project with `require mathlib @ v4.33.0` and `lake exe cache get` gives you
the same environment we run.
