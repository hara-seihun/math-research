import { Worker } from "node:worker_threads";
import type { Mode, NcdDone, NcdJob, Pair, Scored, Unit } from "./ncd-worker.ts";

const WORKERS = Number(process.env.NCD_WORKERS ?? 2);
const JOB_TIMEOUT_MS = Number(process.env.NCD_TIMEOUT_MS ?? 10_000);

type Pending = { resolve: (done: NcdDone) => void; reject: (error: Error) => void; timer: Timer };

class NcdPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, Pending>();
  private next = 0;
  private jobId = 0;

  private spawn(index: number): Worker {
    const worker = new Worker(new URL("./ncd-worker.ts", import.meta.url));
    worker.on("message", (done: NcdDone) => {
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

  run(job: Omit<NcdJob, "id">): Promise<NcdDone> {
    if (this.workers.length < WORKERS) this.spawn(this.workers.length);
    const worker = this.workers[this.next++ % this.workers.length]!;
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
 * `normalized` says the texts are already in normal form — true for anything
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
