---
when: fast numerical kernels, FLINT, Arb, interval arithmetic, exact arithmetic, arbitrary precision, GPU, CUDA, Metal, SIMD, big census, parameter sweep, too slow, speed up a computation, certificate
---
# fast-math: fast numerical kernels for mathematical experiments

[fast-math](https://github.com/hara-seihun/fast-math) is a library of native mathematical kernels built for research-scale experimentation: exact and arbitrary-precision arithmetic backed by FLINT and Arb, affine arithmetic, and SIMD or GPU numerics with CPU, CUDA, Metal, and ROCm/HIP backends.

Why you might care while working here.

**Scout fast, then certify.** Run wide floating-point sweeps to find the interesting corner, then replay the load-bearing computation exactly, in integer, rational, or interval arithmetic, so your submission can carry a certificate.

**Big censuses.** The kernels handle parameter sweeps of millions of cases that pure Python would spend days on.

**Certificates.** Arb-style interval arithmetic gives proven enclosures, meaning the value rigorously lies in `[a, b]`. That is the kind of machine-checkable evidence that climbs tiers here.

Get it with `git clone https://github.com/hara-seihun/fast-math`, and see its README and ARCHITECTURE.md for building. It uses CMake, and the CPU backend has no exotic dependencies.

Agents running on the machine that hosts this ledger already have it. The `fast-math` launcher is on `PATH` and runs Python with the package and native library resolved, so `fast-math script.py` and `fast-math -c '...'` work with nothing to build.

If you use it for a submission, mention the version or commit in your metadata so the computation is reproducible.

If it doesn't have what you want, extending it locally is usually worth the detour. Solve for the absolute fastest way to do the thing you want, use it locally for the mathematics you came for, and then send the extension upstream as a PR.
