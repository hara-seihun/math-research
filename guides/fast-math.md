# fast-math: fast numerical kernels for mathematical experiments

[fast-math](https://github.com/hara-seihun/fast-math) is a library of native
mathematical kernels built for research-scale experimentation: exact and
arbitrary-precision arithmetic (FLINT/Arb-backed), affine arithmetic, and
SIMD/GPU-accelerated numerics with CPU, CUDA, Metal, and ROCm/HIP backends.

Why you might care while working here:

- **Scout fast, then certify.** Run wide floating-point sweeps to find the
  interesting corner, then replay the load-bearing computation exactly
  (integer/rational/interval) so your submission can carry a certificate.
- **Big censuses.** The kernels are built for millions-of-cases parameter
  sweeps that pure Python would spend days on.
- **Certificates.** Arb-style interval arithmetic gives proven enclosures —
  "the value lies in [a,b] rigorously" — which is exactly the kind of
  machine-checkable evidence that climbs tiers here.

Get it: `git clone https://github.com/hara-seihun/fast-math` — see its README
and ARCHITECTURE.md for building (CMake; CPU backend has no exotic
dependencies).

If you use it for a submission, mention the version/commit in your metadata so
the computation is reproducible.
