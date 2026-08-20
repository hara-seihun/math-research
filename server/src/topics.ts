// Subject classification as a derived facet — like notability and
// lean_verified, a computed label rather than an asserted contribution. One
// keyword taxonomy is the single source of truth: submit() tags new work with
// it and the backfill script tags the existing corpus with the same rules, so
// the two can never drift. Cheap, deterministic, and never an AI pass over the
// corpus. Multi-label: a Cayley-graph isomorphism result is both algebraic
// graph theory and group theory.

import { normalizeText } from "./graph.ts";

type Topic = { topic: string; pattern: RegExp };

// Patterns run against normalized (dash-folded, lowercased) text.
const TOPICS: Topic[] = [
  { topic: "analytic-number-theory", pattern: /\b(de bruijn|newman constant|riemann hypothesis|riemann zeta|zeta function|zeta zero|l-function|dirichlet|prime counting|prime number|xi function|critical line|montgomery|pair correlation)\b/ },
  { topic: "number-theory", pattern: /\b(number field|diophantine|modular form|elliptic curve|galois|class number|arithmetic|continued fraction|congruence|quadratic form|p-adic)\b/ },
  { topic: "algebraic-graph-theory", pattern: /\b(cayley graph|cayley|ci-property|ci-group|dci|vertex-transitive|arc-transitive|circulant|graph isomorphism|automorphism group of|edge-transitive|distance-regular|strongly regular|polycirculant|elusive)\b/ },
  { topic: "graph-theory", pattern: /\b(graph|digraph|subgraph|chromatic|colou?ring|planar|spanning tree|hamiltonian|clique|matching|connectivity|cut vertex|centroid|caterpillar|tree isomorphism)\b/ },
  { topic: "group-theory", pattern: /\b(group|subgroup|permutation group|sylow|nilpotent|solvable|abelian|coset|normal subgroup|group action|representation of|character table|conjugacy)\b/ },
  { topic: "combinatorics", pattern: /\b(extremal|ramsey|union-closed|frankl|hypergraph|set system|antichain|poset|latin square|design theory|combinatorial|enumeration|generating function|sunflower)\b/ },
  { topic: "discrete-geometry", pattern: /\b(packing|sphere packing|unit square|kneser|poulsen|ulam|convex body|lattice packing|kissing number|tiling|covering|arrangement of|incidence|unit distance)\b/ },
  { topic: "rigidity-theory", pattern: /\b(rigidity|rigid framework|maxwell|generic rigidity|bar-joint|infinitesimally rigid|jamming|random close packing|isostatic)\b/ },
  { topic: "complexity-theory", pattern: /\b(matrix multiplication|omega exponent|arithmetic circuit|boolean circuit|np-hard|polynomial time|complexity class|lower bound for|tensor rank|border rank|communication complexity)\b/ },
  { topic: "algebra", pattern: /\b(ring|ideal|module|polynomial ring|commutative algebra|field extension|vector space|linear algebra|eigenvalue|matrix|determinant|tensor)\b/ },
  { topic: "analysis", pattern: /\b(inequality|integral|derivative|measure|banach|hilbert space|fourier|harmonic analysis|sobolev|differential equation|pde|convergence|holomorphic|analytic function)\b/ },
  { topic: "probability", pattern: /\b(probability|random|markov|martingale|stochastic|expectation|concentration|percolation|brownian|distribution|almost surely)\b/ },
  { topic: "topology", pattern: /\b(topolog|manifold|homology|homotopy|cohomology|fundamental group|simplicial|knot|fiber bundle|cw complex)\b/ },
  { topic: "operator-algebras", pattern: /\b(operator algebra|c\*-algebra|von neumann|sofic|amenab|factor|spectral triple|k-theory of)\b/ },
  { topic: "optimization", pattern: /\b(optimization|linear program|convex program|semidefinite|duality|gradient|minimax|oracle|regret|online algorithm)\b/ },
  { topic: "logic", pattern: /\b(first-order|model theory|proof theory|decidab|computab|turing|set theory|forcing|axiom of|lambda calculus|type theory)\b/ },
];

const MAX_TAGS = 4;

export function classifyTopics(text: string): string[] {
  const t = normalizeText(text);
  const hits = TOPICS.filter((x) => x.pattern.test(t)).map((x) => x.topic);
  return hits.slice(0, MAX_TAGS);
}

export const topicVocabulary = TOPICS.map((t) => t.topic);
