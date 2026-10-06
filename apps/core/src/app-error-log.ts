import { screenLimits } from "@grasp-os/shared/screens";
import type { AppErrorEntry, AppErrorLog } from "@grasp-os/shared/screens";

// An App's error log: what went wrong in its screens, for the builders and
// the agent who fix it. It lives in the App's own Durable Object (in the
// EU with the App), outside the facet its code runs in.
//
// A screen writes its reports itself, so the log is bounded whatever it
// sends: the same problem is one entry with a count, only the newest
// different problems are kept, and what comes in past the rate the host
// allows (app.ts, `admitReport`) is only counted, in one number.

/**
 * Where the log keeps the number of its newest entry. The stored name
 * stays as it is: an App with reports already has its number under it,
 * and one that started again at 1 would write over the entries it has.
 */
const sequenceKey = "error-log-count";
const suppressedKey = "error-log-suppressed";
const entryPrefix = "error-log:";

/** Entries sort by key in the order they were last reported. */
const entryKey = (sequence: number): string =>
  `${entryPrefix}${String(sequence).padStart(12, "0")}`;

/** A problem as reported, before the log counts it. */
export type ReportedProblem = Omit<AppErrorEntry, "count">;

/** Whether two reports are of the same problem, in the same place. */
const sameProblem = (kept: AppErrorEntry, reported: ReportedProblem): boolean =>
  kept.kind === reported.kind &&
  kept.message === reported.message &&
  kept.stack === reported.stack &&
  kept.version === reported.version &&
  kept.screen === reported.screen;

/** Waits for `promise` to settle, whichever way. */
const settled = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // Whoever needs the outcome awaits the promise itself.
  }
};

/** The error log kept in an App's `storage`. */
export class ErrorLog {
  readonly #storage: DurableObjectStorage;

  /** The last write, settled: the next waits for it. */
  #written: Promise<void> = Promise.resolve();

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  /**
   * Reports dropped unread that the stored count doesn't have yet: they
   * are written at intervals (`writeSuppressed`), never one by one.
   */
  #pending = 0;

  /**
   * Runs `turn` after every one before it. Each reads the log before it
   * writes, and many reports arrive at once: two that read the same log
   * would each add the same problem as new, or count over each other.
   * The object's own ordering of requests doesn't cover it: without this,
   * two hundred reports sent at once come out as dozens of entries (the
   * test of that in screen-bridge.test.ts fails).
   */
  async #inTurn<T>(turn: () => Promise<T>): Promise<T> {
    const before = this.#written;
    const mine = (async (): Promise<T> => {
      await before;
      return await turn();
    })();
    this.#written = settled(mine);
    return await mine;
  }

  /**
   * Adds `reported`: once more of the entry that has the same problem,
   * which becomes the newest, or a new entry, dropping the oldest beyond
   * the log's size.
   */
  async add(reported: ReportedProblem): Promise<void> {
    await this.#inTurn(async () => {
      const kept = await this.#storage.list<AppErrorEntry>({
        prefix: entryPrefix,
      });
      const sequence =
        ((await this.#storage.get<number>(sequenceKey)) ?? 0) + 1;
      const same = [...kept].find(([, entry]) => sameProblem(entry, reported));
      const [oldest] = kept.keys();
      let dropped: string | undefined;
      if (same !== undefined) {
        [dropped] = same;
      } else if (kept.size >= screenLimits.keptReports) {
        dropped = oldest;
      }
      await this.#storage.put({
        [sequenceKey]: sequence,
        [entryKey(sequence)]: {
          ...reported,
          count: (same?.[1].count ?? 0) + 1,
        } satisfies AppErrorEntry,
      });
      if (dropped !== undefined) {
        await this.#storage.delete(dropped);
      }
    });
  }

  /** Counts one more report as dropped unread: in memory, for now. */
  suppress(): void {
    this.#pending += 1;
  }

  /**
   * Adds the reports dropped since the last write to the stored count.
   * They leave memory only once storage has them, so a write that fails
   * loses none. Answers how many it wrote.
   */
  async writeSuppressed(): Promise<number> {
    return await this.#inTurn(async () => {
      const reports = this.#pending;
      if (reports === 0) {
        return 0;
      }
      const before = (await this.#storage.get<number>(suppressedKey)) ?? 0;
      await this.#storage.put(suppressedKey, before + reports);
      this.#pending -= reports;
      return reports;
    });
  }

  /**
   * The log, newest first, once every write so far is in it, with every
   * report dropped so far counted: those stored and those still in
   * memory. Reading writes nothing.
   */
  async read(): Promise<AppErrorLog> {
    return await this.#inTurn(async () => {
      const entries = await this.#storage.list<AppErrorEntry>({
        prefix: entryPrefix,
        reverse: true,
        limit: screenLimits.keptReports,
      });
      const stored = (await this.#storage.get<number>(suppressedKey)) ?? 0;
      return {
        entries: [...entries.values()],
        suppressed: stored + this.#pending,
      };
    });
  }
}
