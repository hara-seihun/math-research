import { parentPort } from "node:worker_threads";

// Compression distance is the one piece of request handling that is pure CPU
// with no await in it: 150 candidates gzipped twice each, on a single-threaded
// runtime, is 150 chances to stall every other request in flight. It runs here
// instead.

export type NcdJob = { id: number; query: string; candidates: { id: string; content: string }[] };
export type NcdDone = { id: number; scored: { id: string; similarity: number }[] };

const size = (s: string): number => Bun.gzipSync(Buffer.from(s)).length;

function similarity(query: string, cq: number, candidate: string): number {
  const cy = size(candidate);
  const cxy = size(`${query}\n${candidate}`);
  const ncd = (cxy - Math.min(cq, cy)) / Math.max(cq, cy);
  return Number((1 - ncd).toFixed(4));
}

parentPort!.on("message", (job: NcdJob) => {
  const cq = size(job.query);
  const done: NcdDone = {
    id: job.id,
    scored: job.candidates.map((c) => ({ id: c.id, similarity: similarity(job.query, cq, c.content) })),
  };
  parentPort!.postMessage(done);
});
