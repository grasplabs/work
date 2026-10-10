import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import type {
  SubmissionIntent,
  SubmissionIntentKind,
} from "@grasp-os/shared/submissions";

// Handing a committed submission's intents over to whoever takes them,
// the same for every outbox that holds them: the Knowledge outbox of
// record saves (knowledge/outbox.ts) and each business store's
// (data-store.ts). Each outbox leases, settles and retries its own
// entries; what an entry is, who takes it, how long a hand-over may take
// and how failures back off is here, once.

/** An entry as a consumer takes it. */
export interface OutboxEntry {
  /** The same each time it is handed over. */
  id: string;
  intent: SubmissionIntent;
  /** How many hand-overs of it failed before. */
  attempts: number;
  /** Aborted once the hand-over's time is up. */
  signal: AbortSignal;
}

/**
 * Takes one entry: `delivered`, or settled undeliverable for good with a
 * code (`{ undeliverable }`), such as a run that ended. Throws to have it
 * handed over again later.
 */
export type OutboxConsumer = (
  entry: OutboxEntry
) => Promise<"delivered" | { undeliverable: string }>;

export type OutboxConsumers = Partial<
  Record<SubmissionIntentKind, OutboxConsumer>
>;

/** The consumers of this deployment's outbox: none yet. */
export const outboxConsumers: OutboxConsumers = {};

/** How a drain goes. */
export interface DrainOptions {
  /** The time it starts at; its clock runs on from there. */
  now?: Date;
  /** How long one hand-over may take. */
  timeoutMs?: number;
  /**
   * How long the drain goes on handing entries over: checked before each
   * entry, so it hands over at least one.
   */
  budgetMs?: number;
  /** How many failed hand-overs settle an entry as undeliverable. */
  maxAttempts?: number;
}

/** How long one hand-over may take, unless a drain says otherwise. */
export const defaultTimeoutMs = 30_000;

/** How long a drain goes on handing over, unless it says otherwise. */
export const defaultBudgetMs = 20_000;

/**
 * How many failed hand-overs settle an entry as undeliverable, unless a
 * drain says otherwise: the backoff reaches hourly by the 8th, so this is
 * about a day of hourly retries, enough to outlast a consumer's outage.
 * Its consumers' delivery (GRA-372) is to confirm it.
 */
export const defaultMaxAttempts = 32;

/** The longest wait before an entry is handed over again. */
const maxBackoffMs = 60 * 60 * 1000;

/** The wait before the next hand-over, after `attempts` failed ones. */
export const backoffMs = (attempts: number): number =>
  Math.min(maxBackoffMs, 30_000 * 2 ** Math.min(attempts - 1, 20));

/** What a hand-over came to. */
type Handed =
  | { settled: "delivered" | { undeliverable: string } }
  | { failed: unknown };

/** Hands `entry` to `consumer`, within `timeoutMs`. */
export const handOver = async (
  consumer: OutboxConsumer,
  entry: Omit<OutboxEntry, "signal">,
  timeoutMs: number
): Promise<Handed> => {
  const limit = deadline(timeoutMs);
  try {
    return {
      settled: await Promise.race([
        consumer({ ...entry, signal: limit.signal }),
        whenAborted(limit.signal),
      ]),
    };
  } catch (error) {
    return { failed: error };
  } finally {
    limit.clear();
  }
};
