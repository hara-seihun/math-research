import { normalizeDecl } from "../server/src/similarity.ts";

type Input = { name: string; statement: string }[];

self.onmessage = (event: MessageEvent<Input>) => {
  self.postMessage(event.data.map((row) => normalizeDecl(row.name, row.statement)));
};
