/**
 * Where a watcher's updates go: the page's callback, through core, which
 * is let go of with the watcher.
 */
export type Listener<T> = ((update: T) => Promise<unknown>) & Disposable;

/**
 * What a watcher's updates go out through, one at a time: while one is on
 * its way, whatever changes waits, and the next update (`next`, read as it
 * goes out) carries it all, so a slow connection gets a few updates, never
 * a queue of them. An update that fails (the connection is gone, the person
 * may no longer follow) drops the watcher. The chat's watch and the list's
 * both go out through it.
 */
export class Pushes<T> {
  readonly #listener: Listener<T>;
  readonly #next: () => T | undefined;
  readonly #drop: () => void;
  /** Something changed since the last update went out. */
  #changed = false;
  #sending = false;

  constructor(
    listener: Listener<T>,
    /** The update to send now; none when nothing the watcher has changed. */
    next: () => T | undefined,
    drop: () => void
  ) {
    this.#listener = listener;
    this.#next = next;
    this.#drop = drop;
  }

  /** Something changed: an update goes out, now or after the one on its way. */
  changed(): void {
    this.#changed = true;
    void this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#sending) {
      return;
    }
    this.#sending = true;
    try {
      while (this.#changed) {
        this.#changed = false;
        const update = this.#next();
        if (update !== undefined) {
          // oxlint-disable-next-line no-await-in-loop -- one update at a time, in order
          await this.#listener(update);
        }
      }
    } catch {
      this.#drop();
    } finally {
      this.#sending = false;
    }
  }

  [Symbol.dispose](): void {
    this.#changed = false;
    this.#listener[Symbol.dispose]();
  }
}
