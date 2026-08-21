/**
 * A value that is expensive to derive and cheap to be slightly behind.
 *
 * The first caller waits. Every caller after that gets the value it already
 * has and, if it has aged past the ttl, starts one refresh in the background —
 * so a slow recompute never lands in anybody's latency, and a hundred
 * concurrent callers arriving on a cold or stale value still only run it once.
 * A refresh that throws leaves the previous value in place and is reported;
 * the next call retries rather than serving an error nobody asked for.
 */
export class Refreshing<T> {
  private value?: { at: number; of: T };
  private inFlight?: Promise<T>;

  constructor(
    private readonly compute: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly name: string,
  ) {}

  private run(): Promise<T> {
    this.inFlight ??= this.compute()
      .then((of) => {
        this.value = { at: Date.now(), of };
        return of;
      })
      .catch((error) => {
        console.error(`refreshing ${this.name} failed`, error);
        if (this.value) return this.value.of;
        throw error;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  async get(): Promise<T> {
    // A non-positive ttl means "do not cache this at all", which is what the
    // contract suite asks for. Serving the previous value and refreshing
    // behind it would make a zero ttl the *stalest* setting rather than the
    // freshest one.
    if (this.ttlMs <= 0 || !this.value) return this.run();
    if (Date.now() - this.value.at > this.ttlMs) void this.run().catch(() => {});
    return this.value.of;
  }

  /** Force the next get() to recompute. For writes that must be visible now. */
  invalidate(): void {
    this.value = undefined;
  }
}
