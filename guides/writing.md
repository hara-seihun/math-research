---
when: writing it up, paper, manuscript, exposition, how to present a proof, TeX, LaTeX, abstract, announcement, blog post, press, arXiv, attribution, prior art, state of the art, novelty, provenance of a number, interval arithmetic, certificate, reproducibility, referee, hedging, hype, slop
---
# Writing it up so a stranger can check it

A result nobody else can follow is a rumour with notation on it. The write-up is not packaging for the mathematics, it is the part that transmits, and it is the only part a reviewer, a referee, or an agent six months from now actually has.

So this guide is what to do once you have the result: how to say what is new, how to leave a visible reason under every step, how to write about a computation without turning code into an oracle, and how to talk about the outcome in public without joining the slop pile.

It applies to everything that leaves your session as prose. A submission here, a manuscript, a standalone `.tex` note, an abstract, a summary blurb, an announcement, a mail to the author of the problem you just settled. The rules of the ledger itself — tiers, origin, rejection, importance — are `guides({name:'how-this-works'})` and are not repeated here.

## Write the mathematics, not the software

Treat a program as a way of evaluating a mathematical quantity you have already defined in the text, never as an unnamed proof oracle. The reader must be able to state your theorem, its hypotheses, and every finite claim the computation settles, without opening the source.

The practical test: delete the repository. Is the theorem still fully stated? Is every proof-critical number still defined? Is the finite search space, the equivalence used to prune it, and the acceptance inequality still on the page? If not, the missing part is mathematics that got left in the code.

## Say what is new, right where you use it

Establish the state of the art from primary sources, and compare against the strongest relevant result rather than the most convenient older one. Separate published, refereed, accepted, and unrefereed claims accurately. If a stronger unrefereed claim exists, name it without relying on it.

Then build a contribution map: for each thing you claim is new, name the prior theorem, lemma, estimate, or algorithm and state exactly what changed mathematically. "We improve Lemma 3.2 of A–B by replacing the trivial bound on the tail with a stationary-phase estimate" is a contribution. "We used more computation" is not one, unless complexity or scale is itself the theorem.

Cite the exact theorem, lemma, equation, table, or estimate you are improving, near the point of use rather than in a distant related-work paragraph. Verify authors, title, identifier, version, date, and theorem number; resolve every citation before shipping, and never cite a paper for a claim it does not make — check the text, not the abstract. Fabricated and mis-attributed citations are the single most recognisable signature of machine-written mathematics, and readers now scan for it first.

Do not present unpublished internal work — yours or this ledger's — as recognised prior art.

## Every non-trivial step has a visible reason

`clearly`, `obviously`, `it is easy to see`, and an unsupported appeal to `standard` are all the same sentence: *there is a calculation here and I am not showing it*. Replace each with the calculation, the invariant, or the citation.

Some bridges that are almost always skipped and almost always where the error is:

- **A map is an isomorphism.** Take an arbitrary edge, relation, or defining operation, calculate its image, and identify the target. Establish bijectivity separately.
- **These are all the automorphisms.** Identify the characteristic or otherwise invariant substructure, prove an automorphism preserves it, derive the permitted action on it and the images of the remaining generators. If that gives a normal form, state the parametrising bijection; if composition respects it, calculate the group law and state the isomorphism. Later order counts cite *that* statement, not an unstated consequence.
- **The obstruction transports upward.** Prove the relevant generated subobject is recovered from the displayed data, then show a hypothetical ambient equivalence restricts to the forbidden one.
- **By Theorem X.** Match every hypothesis explicitly at the point of use, including existence, well-definedness, uniqueness, and boundary cases.
- **A finite check settles it.** State the exact predicate, the complete search space, the group action or equivalence used to reduce it, the arithmetic or canonicalisation method, and what the returned counts imply.

Never write "the preceding lemma shows" when the conclusion you need is not the literal statement of that lemma. Cite it and state the intervening deduction, especially when you also need uniqueness, surjectivity, or a count.

## Introduce things in the order they depend on each other

Ambient structures, then parameters, elements, sets, maps, operations, derived objects, statements, proofs. Define every term before it carries logical weight. Type every variable where it is introduced, type bound variables in their quantifiers, and give the domain and codomain of every map. Keep the symbol ledger privately if you like, but the reader should never meet an untyped letter.

Use standard mathematical vocabulary. A private architectural noun — *charge*, *gate*, *seam*, *canopy*, *voltage*, *layer* — standing in for an upper bound, a threshold, an interval boundary, or an ordinary coordinate is a term the reader has to learn for nothing. Write `kernel` only after naming the map whose kernel it is. If a coined term is used once, delete it and name the object.

Name a section by the mathematics in it, not by its role in your drafting process. `Imported results`, `the finite case`, and `the obstruction` are workflow headings. Name the theorem, the group, the family.

Write in the present tense and present the mathematics synchronically: no discovery history, no revision narrative, no defensive paragraph about the approaches you did not take. Prefer one logical move per sentence, and split a sentence that carries a hypothesis, a failed prior argument, and a new conclusion at once.

For a classification, separate logical dependency order from reader-facing order. State the main theorem early, give the strongest prior reduction, state exactly which cases that reduction leaves, and organise the body around those cases and the phenomenon that resolves them. When exceptional objects are positive only in isolation, present each positive case beside the theorem showing its natural extensions fail — that makes the narrative structural instead of a list of curiosities.

When you overturn a published expectation, get its formal status exactly right: a proved theorem, a numbered conjecture, an informal prediction, and a heuristic are four different things and an unnumbered sentence is none of them. Reconstruct why the expectation was plausible from the examples and methods then available, and identify the mechanism your counterexample exposes. A family that passes every local or Sylow condition and fails globally is a story about local data failing to control a global invariant, not about earlier authors being careless.

## Displays and notation

Make every display part of a grammatical sentence and punctuate it as one. Number a display only if you cite it later, and give labels stable descriptive names. Prefer `$...$` for short notation that fits in a sentence; reserve a display for definitions, calculations, and assertions that carry emphasis or a later label. Put prose around a substantive chain of equalities, naming the reason for each transition that is not immediate from the adjacent definition.

If the task asks for the strict standalone style, begin directly with definitions and hypotheses, omit title matter, abstract, introduction, motivation, and survey, write in formal British English, and use no semicolon, em dash, or colon in rendered text — commas, full stops, parentheses, and separate sentences instead.

## A computational proof has the same skeleton as any other

1. State the analytic or combinatorial criterion.
2. Define every function and normalisation.
3. Prove the symbolic reductions.
4. State the finite verification propositions, with exact domains and inequalities.
5. Explain the enclosure or enumeration method.
6. Give the certified result.
7. Deduce the theorem.

Code evaluates 4 and 5. It must not be the only place 4 and 5 are stated. Promote a structural remark the computation leans on to a proposition with a proof; a load-bearing inequality left as an informal observation is a hole.

Keep implementation out of the argument. Algorithms, data formats, dependency versions, commands, hashes, and performance notes belong in an implementation appendix or a companion artifact, ordered: mathematical predicate, theorem-preserving algorithm or subdivision rule, arithmetic and rounding model, numerical results, implementation, reproduction.

## Every proof-critical number has a definition

"Numerical computations show" is not provenance. For each constant, threshold, count, or minimum the proof depends on, record: its symbol and exact value where exact; its mathematical definition; why that value was chosen; the source theorem, formula, or prior computation; the arithmetic system and rounding mode; the working precision and error bound; the partition, checkpoint, or certificate it comes from; any independent cross-check; the exact reproduction command; and the expected output or acceptance threshold. Derived counts and minima get the same treatment as input parameters.

A path to a JSON file is not the provenance of a value. Paths, manifests, hashes, and replay commands are supporting metadata; they never replace a definition or an enclosure argument.

For the arithmetic itself: prefer integer and rational arithmetic for combinatorial and algebraic steps; use an established arbitrary-precision interval or ball library for transcendental ones; say whether complex enclosures are rectangles or discs; say how outward rounding is guaranteed and how branches of logarithms, powers, and special functions are fixed; give an independent calculation for high-leverage scalars; and treat a native floating-point kernel as heuristic unless its error is enclosed by a proved bound. Formalising a small structural lemma is often cheaper than writing bespoke proof code for it — see `guides({name:'lean'})`. Scouting in floating point and certifying the load-bearing step exactly is the standard shape, and `guides({name:'fast-math'})` is the local kit for it.

A subtle failure worth naming, because it survives every hash check and every replay: a certificate chain that drops a phase, a carrier, or a normalisation certifies a *surrogate* function, not the one in the theorem. When you simplify inside the verified region, prove the simplification is theorem-preserving, or state the surrogate as the actual claim.

## The root of trust, in order

1. Published theorems, cited with hypotheses matched explicitly.
2. Short exact lemmas proved in the paper or in a proof assistant.
3. Exact rational or integer calculation, reproducible in a vetted CAS.
4. Directed interval or ball arithmetic in a documented, vetted library.
5. Minimal glue code whose semantics are described and tested independently.
6. Certificates, hashes, manifests, replay tooling.

Do not collapse 3–6 into "the verifier proves it". Say which layer establishes each claim and what remains in the trusted computing base. A hash proves identity, not truth. A replay proves repeatability, not that the encoded mathematics is right. And two implementations that share formulas, generated data, or certificates are one implementation — do not call that independent verification.

## Reproducibility appendix

Archive identifier, immutable revision or content digest, directory map, dependency versions and lockfiles, commands from clean checkout to final receipt, expected runtime and memory and disk, checkpoint and resume behaviour, machine-readable and human-readable outputs, the meaning of every certificate field the proof uses, and any check that is still incomplete. Name the actual distribution boundary rather than claiming the source archive contains something distributed elsewhere, and package ancillary code so it runs without your working repository. A private path is never an explanation or a verification of a mathematical claim.

## Cut before you ship

Delete or rewrite, without exception:

- defensive statements denying readings no reasonable reader would attempt;
- "for completeness" paragraphs that quietly contain the central prior art;
- vague provenance: "a computation verifies", "extensive testing", "it can be checked";
- implementation chronology standing in for mathematical argument;
- novelty claims with no named comparison;
- decorative named lemmas that are never cited and expose no reusable fact;
- long sentences mixing representation, obstruction, and remedy;
- throat-clearing of every kind.

## Talking about it in public

Website copy, blurbs, abstracts, announcements, correspondence, and posts get the paper standards plus these. They exist because the audience has been burned: the October 2025 "GPT-5 solved ten Erdős problems" episode ended with the database maintainer explaining that no discoveries had occurred and the "solutions" were literature finds, and that episode is now the lens every such announcement is read through. Tao's public accounting says the same thing more gently — most AI contributions to those lists are souped-up literature search, genuine originals are rare, and untouched problems did not "resist" anyone. Buzzard's bar is the one to aim at: *has this system ever told us something interesting we did not already know?* Write so that question can be answered with checkable specifics.

Say which of three things you have, and never blur them: the mathematics is original as far as a completed priority sweep shows; or it assembles known results into a resolution nobody had assembled (honourable, common, say so plainly); or it existed in the literature and you found, reconstructed, or repaired it. Only the first may use discovery language. Inside the ledger this is the `origin` field and its source, which `guides({name:'how-this-works'})` explains; outside it, say it in words. Do not announce before the priority sweep is finished, and state its date and scope: "checked MathSciNet, arXiv, and the problem database's citation tree, 2026-08-14".

Never write: "solved" for anything but a swept, pinned original (and prefer "settled", "resolved", "refuted", "closed the case a ≤ N" even then); "breakthrough", "superhuman", "revolutionary", "first AI to", "PhD-level", "gold-medal"; "resisted mathematicians for N years", since untouched is not resistant; bare counts with no denominator; benchmark comparisons; forward-looking claims, roadmaps, or probabilities of future results; "no human in the loop" as a boast; "AI mathematician" as a noun; or any sentence whose subject is the system's intelligence rather than the mathematics.

Always: denominators, never a bare count — "8 of the 16 cells are settled, and the open slices are exactly these", not "we settled 8 cells". A verification pointer — "verify this yourself: *exact command*, about N minutes". Past tense and finished things, because the strongest sentence available is a checkable one. Open cases stated beside closed ones, in the same visual register. And errors as first-class content: "we claimed X on this date, our audit found the gap on that date, the withdrawal is here". A self-refutation receipt buys more credibility than a success claim, and publishing one is how a ledger stays worth reading.

Etiquette toward the sources you used: contact the maintainer of a problem database or published problem list, with a literature-checked, provenance-labelled write-up, *before* any public announcement referencing their list. Follow a collaborative platform's contribution norms exactly and never claim credit on its territory. When you settle a question posed in a specific paper, cite the exact section or problem number and tell the authors, before or alongside the public mention.

Register: a result blurb is two to four sentences, standard vocabulary, one provenance label, one verification pointer, written for a professional mathematician skimming. An announcement adds an explicit statement of what is *not* claimed wherever a stronger adjacent claim exists.

## arXiv

Checked against official policy on 2026-07-28; re-check before submitting, since the rules have been moving.

The submitter and authors are responsible for accuracy, originality, legality, and scholarly character. Submissions may be declined for insufficient originality, novelty, or significance, or for serious misrepresentation, and identity, authorship, affiliation, provenance, endorsement, and verification status must not be misrepresented. Significant use of generative-AI language tools should be reported. An AI system cannot be an author, because it can neither consent to submission nor take responsibility; a human author must inspect, verify, and accept responsibility for all text, mathematics, citations, and code. Enforcement runs from warnings through submission restrictions, suspension, and removal, with permanent suspension in some identity cases — but there is no blanket one-year ban for machine-written text, so do not repeat that claim.

- <https://info.arxiv.org/help/moderation/index.html>
- <https://info.arxiv.org/help/policies/code_of_conduct.html>
- <https://info.arxiv.org/help/submit/submission_agreement.html>
- <https://info.arxiv.org/help/policies/identity_affiliation.html>

## Final audit

Read the source line by line and check that every symbol is introduced before use, every variable has a declared type, every term is defined, every imported theorem has its hypotheses checked at the point of use, every non-trivial implication has a reason, every map is well-defined and bijective where required, every referenced display and citation resolves, every display is grammatical and punctuated, no weak transition is hiding a calculation, and the source compiles with no errors or unresolved references. Then replay every check you can and report the ones you could not, plainly, in the manuscript.
