import { Worker } from "node:worker_threads";
import type { Mode, NcdDone, NcdJob, Pair, Scored, Unit } from "./ncd-worker.ts";

const WORKERS = Number(process.env.NCD_WORKERS ?? 2);
const JOB_TIMEOUT_MS = Number(process.env.NCD_TIMEOUT_MS ?? 10_000);

type Pending = { resolve: (done: NcdDone) => void; reject: (error: Error) => void; timer: Timer };

// Omit over a union keeps only the keys every member shares, which for a job
// type discriminated by `kind` is the discriminant and nothing else: a caller
// could then hand the pool a rank job with no candidates and be told nothing.
// Distributing it keeps each variant whole.
type Submitted<T> = T extends unknown ? Omit<T, "id"> : never;

class NcdPool {
  private readonly workers: Worker[] = [];
  private readonly inFlight: number[] = [];
  private readonly pending = new Map<number, Pending>();
  private jobId = 0;

  // Spawned at startup, not on first use: standing a Bun worker up and loading
  // its module graph took five seconds, and lazily it was a request that paid
  // for it. Warmed with a real job for the same reason.
  constructor() {
    for (let i = 0; i < WORKERS; i++) this.spawn(i);
    void Promise.all(
      this.workers.map(() => this.run({ kind: "rank", mode: "lean", query: "warm", candidates: [{ id: "0", text: "warm" }] })),
    ).catch(() => {});
  }

  private spawn(index: number): Worker {
    const worker = new Worker(new URL("./ncd-worker.ts", import.meta.url));
    worker.on("message", (done: NcdDone) => {
      this.inFlight[index] = Math.max(0, (this.inFlight[index] ?? 1) - 1);
      const waiter = this.pending.get(done.id);
      if (!waiter) return;
      this.pending.delete(done.id);
      clearTimeout(waiter.timer);
      waiter.resolve(done);
    });
    // A worker that dies takes its in-flight job with it. Fail those callers
    // rather than leaving them hanging, and stand a replacement back up: the
    // next request must not find an empty pool.
    worker.on("error", (error: unknown) => this.replace(index, error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => {
      if (code !== 0) this.replace(index, new Error(`ncd worker exited with ${code}`));
    });
    worker.unref();
    this.workers[index] = worker;
    this.inFlight[index] = 0;
    return worker;
  }

  private replace(index: number, error: Error): void {
    console.error("ncd worker failed", error);
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.spawn(index);
  }

  run(job: Submitted<NcdJob>): Promise<NcdDone> {
    // Least loaded rather than round robin: a namespace scan occupies a worker
    // for a while, and the next caller should not queue behind it while a
    // second worker sits idle.
    let index = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.inFlight[i]! < this.inFlight[index]!) index = i;
    const worker = this.workers[index]!;
    this.inFlight[index]!++;
    const id = ++this.jobId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ncd scoring timed out"));
      }, JOB_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...job, id } as NcdJob);
    });
  }
}

const pool = new NcdPool();

/**
 * Rank candidates by alpha-normalized compression distance against a query.
 * `normalized` says the texts are already in normal form, true for anything
 * read out of `lean_decl.norm` or `lean_unit.norm`, false for text that just
 * arrived.
 */
export async function rankBySimilarity(
  args: { mode: Mode; query: string; candidates: Unit[]; normalized?: boolean },
): Promise<Scored[]> {
  if (args.candidates.length === 0) return [];
  const done = await pool.run({ kind: "rank", ...args });
  return done.kind === "rank" ? done.scored : [];
}

/** Near-duplicate pairs inside one set of units, above a similarity floor. */
export async function clusterBySimilarity(
  args: { mode: Mode; units: Unit[]; threshold: number; limit: number; normalized?: boolean },
): Promise<{ pairs: Pair[]; compared: number }> {
  if (args.units.length < 2) return { pairs: [], compared: 0 };
  const done = await pool.run({ kind: "cluster", ...args });
  return done.kind === "cluster" ? { pairs: done.pairs, compared: done.compared } : { pairs: [], compared: 0 };
}

export type { Pair, Scored, Unit };
