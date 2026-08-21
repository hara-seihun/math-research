-- Default tuning policy: the notability weights and the topic taxonomy.
-- Loaded by both schema.sql (fresh installs) and the migration (\ir), so there
-- is exactly one source for the defaults. Idempotent and non-clobbering: it
-- seeds only what is missing, so a trusted operator's live tuning (via
-- set_tuning) is never overwritten by a re-run.

insert into config (key, value) values
  ('notability_weights', '{
    "kind": {"theorem":3.0,"tool":3.0,"front":3.0,"proof":2.5,"theory":2.5,
             "counterexample":2.0,"conjecture":2.0,"result":2.0,"definition":1.5,
             "problem":1.5,"route":1.5,"computation":1.0,"statement":0.6,
             "review":0.4,"edge":0.0,"_default":1.0},
    "rel": {"proves":1.5,"answers":1.5,"serves":1.2,"disproves":1.2,"refutes":1.2,
            "generalizes":1.2,"uses":1.0,"depends-on":1.0,"equivalent-to":1.0,
            "attacks":0.8,"refines":0.8,"specializes":0.6,"repairs":0.6,"about":0.3,
            "reviews":0.3,"supersedes":0.2,"in-front":0.1,"part-of":0.1,
            "duplicates":0.1,"_default":0.5},
    "tier": {"0":0.0,"1":1.0,"2":3.0,"3":6.0},
    "edge_tier": {"0":0.25,"1":0.5,"2":1.0,"3":1.0},
    "edge_scale": 2.0,
    "settle_rels": ["answers","proves","disproves","refutes","resolves"],
    "settle": 0.5,
    "lean": 0.75
  }'::jsonb)
on conflict (key) do nothing;

insert into topic_rule (topic, pattern, ord) values
  ('analytic-number-theory', '\y(de bruijn|newman constant|riemann hypothesis|riemann zeta|zeta function|zeta zero|l-function|dirichlet|prime counting|prime number|xi function|critical line|montgomery|pair correlation)\y', 1),
  ('number-theory', '\y(number field|diophantine|modular form|elliptic curve|galois|class number|arithmetic|continued fraction|congruence|quadratic form|p-adic)\y', 2),
  ('algebraic-graph-theory', '\y(cayley graph|cayley|ci-property|ci-group|dci|vertex-transitive|arc-transitive|circulant|graph isomorphism|automorphism group of|edge-transitive|distance-regular|strongly regular|polycirculant|elusive)\y', 3),
  ('graph-theory', '\y(graph|digraph|subgraph|chromatic|colou?ring|planar|spanning tree|hamiltonian|clique|matching|connectivity|cut vertex|centroid|caterpillar|tree isomorphism)\y', 4),
  ('group-theory', '\y(group|subgroup|permutation group|sylow|nilpotent|solvable|abelian|coset|normal subgroup|group action|representation of|character table|conjugacy)\y', 5),
  ('combinatorics', '\y(extremal|ramsey|union-closed|frankl|hypergraph|set system|antichain|poset|latin square|design theory|combinatorial|enumeration|generating function|sunflower)\y', 6),
  ('discrete-geometry', '\y(packing|sphere packing|unit square|kneser|poulsen|ulam|convex body|lattice packing|kissing number|tiling|covering|arrangement of|incidence|unit distance)\y', 7),
  ('rigidity-theory', '\y(rigidity|rigid framework|maxwell|generic rigidity|bar-joint|infinitesimally rigid|jamming|random close packing|isostatic)\y', 8),
  ('complexity-theory', '\y(matrix multiplication|omega exponent|arithmetic circuit|boolean circuit|np-hard|polynomial time|complexity class|lower bound for|tensor rank|border rank|communication complexity)\y', 9),
  ('algebra', '\y(ring|ideal|module|polynomial ring|commutative algebra|field extension|vector space|linear algebra|eigenvalue|matrix|determinant|tensor)\y', 10),
  ('analysis', '\y(inequality|integral|derivative|measure|banach|hilbert space|fourier|harmonic analysis|sobolev|differential equation|pde|convergence|holomorphic|analytic function)\y', 11),
  ('probability', '\y(probability|random|markov|martingale|stochastic|expectation|concentration|percolation|brownian|distribution|almost surely)\y', 12),
  ('topology', '\y(topolog|manifold|homology|homotopy|cohomology|fundamental group|simplicial|knot|fiber bundle|cw complex)\y', 13),
  ('operator-algebras', '\y(operator algebra|c\*-algebra|von neumann|sofic|amenab|factor|spectral triple|k-theory of)\y', 14),
  ('optimization', '\y(optimization|linear program|convex program|semidefinite|duality|gradient|minimax|oracle|regret|online algorithm)\y', 15),
  ('logic', '\y(first-order|model theory|proof theory|decidab|computab|turing|set theory|forcing|axiom of|lambda calculus|type theory)\y', 16)
on conflict (topic) do nothing;
