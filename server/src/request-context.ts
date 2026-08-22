import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What the transport knows about the request being served, available to any
 * layer without threading it through every signature. Every field is
 * optional: an unidentified caller is a first-class caller here.
 *
 * It lives in its own module rather than inside identity.ts because the
 * request log needs it too, and a database module importing the identity
 * module (which imports the database) is a cycle waiting to surprise someone.
 */
export type RequestContext = {
  bearer?: string;
  sessionId?: string;
  minted?: string;
  /** Whoever this request turned out to belong to, filled in as the handler
   *  resolves it, so the request log can name the caller without asking the
   *  database a second time. */
  resolved?: string | null;
  address?: string;
};

const context = new AsyncLocalStorage<RequestContext>();

export function withRequestContext<T>(ctx: RequestContext, run: () => T): T {
  return context.run(ctx, run);
}

export const requestContext = (): RequestContext => context.getStore() ?? {};

/** Record who the request turned out to belong to, and hand the id straight
 *  back so a resolver can `return remember(id)`. */
export const remember = (identityId: string | null): string | null => {
  const store = context.getStore();
  if (store) store.resolved = identityId;
  return identityId;
};
