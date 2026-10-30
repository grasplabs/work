/**
 * What the admin's watch reads of a client's Stephen, and each signal's
 * bar (src/clients/watch.ts): plain, so the client's Setup can say which
 * are over theirs too.
 */
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { z } from "zod";

/** What the watch reads of a client's Stephen, as its Setup shows it. */
export const watchedSignalsSchema = z.object({
  /** How many hours the chat counts cover. */
  hours: z.int(),
  answered: z.int(),
  failed: z.int(),
  refused: z.int(),
  overBudget: z.int(),
  busy: z.int(),
  /** Sends the platform didn't take, the uninstalled ones apart. */
  sendFailed: z.int(),
  uninstalled: z.int(),
  p50Ms: z.int().nullable(),
  p90Ms: z.int().nullable(),
  /** The company's own connections that need a new sign-in. */
  companyAgain: z.int(),
  /** People's own connections that need a new sign-in. */
  personalAgain: z.int(),
});
export type WatchedSignals = z.infer<typeof watchedSignalsSchema>;

/** How many turns it takes before a failure rate means anything. */
const fewestTurns = 5;
/** How many answers it takes before their p90 means anything. */
const fewestAnswers = 10;

/** A signal the watch holds to a bar. */
export type SignalKind =
  | "stephen_refused"
  | "stephen_failing"
  | "stephen_slow"
  | "stephen_over_budget"
  | "stephen_busy"
  | "stephen_sends_failing"
  | "stephen_uninstalled"
  | "stephen_connections_again";

/**
 * Each signal's bar: whether it's over. From the plan's release bars (p90
 * of 12 s with an app) and what a person at Grasp should look at the same
 * day.
 */
const bars: readonly {
  kind: SignalKind;
  over: (signals: WatchedSignals) => boolean;
}[] = [
  {
    // A handful are the internet trying; more are Teams' own messages
    // refused, as a bot id or tenant that isn't the client's would.
    kind: "stephen_refused",
    over: ({ refused }) => refused > 20,
  },
  {
    kind: "stephen_failing",
    over: ({ answered, failed }) => {
      const turns = answered + failed;
      return turns >= fewestTurns && failed / turns > 0.1;
    },
  },
  {
    kind: "stephen_slow",
    over: ({ answered, p90Ms }) =>
      answered >= fewestAnswers && p90Ms !== null && p90Ms > 12_000,
  },
  {
    kind: "stephen_over_budget",
    over: ({ overBudget }) => overBudget > 0,
  },
  {
    kind: "stephen_busy",
    over: ({ busy }) => busy > 10,
  },
  {
    kind: "stephen_sends_failing",
    over: ({ sendFailed }) => sendFailed > 0,
  },
  {
    // One person removing the app is theirs to do; several, the company's.
    kind: "stephen_uninstalled",
    over: ({ uninstalled }) => uninstalled >= 3,
  },
  {
    kind: "stephen_connections_again",
    over: ({ companyAgain, personalAgain }) =>
      companyAgain > 0 || personalAgain >= 5,
  },
];

/** Which of `signals` are over their bar. */
export const overBars = (signals: WatchedSignals): Set<SignalKind> =>
  new Set(bars.flatMap(({ kind, over }) => (over(signals) ? [kind] : [])));

/**
 * What the watch reads of `snapshot`; null from a core that doesn't count
 * Stephen yet, or couldn't read its counts.
 */
export const signalsOf = (snapshot: AdminSnapshot): WatchedSignals | null => {
  const { stephen, integrations } = snapshot;
  if (stephen === null || stephen === undefined) {
    return null;
  }
  return {
    hours: stephen.hours,
    answered: stephen.answered,
    failed: stephen.failed,
    refused: stephen.refused,
    overBudget: stephen.overBudget,
    busy: stephen.busy,
    sendFailed: Math.max(0, stephen.sendFailed - stephen.uninstalled),
    uninstalled: stephen.uninstalled,
    p50Ms: stephen.p50Ms,
    p90Ms: stephen.p90Ms,
    companyAgain:
      integrations?.connected.filter(({ state }) => state === "again").length ??
      0,
    personalAgain:
      integrations?.personal.reduce((sum, { again }) => sum + again, 0) ?? 0,
  };
};
