// What a test's run reaches of its test on-prem: the suite's sandbox
// session, as a test's own calls do (app-tests.ts, `FixtureSession`). Its
// store calls run App code in the sandbox (fixture-calls.ts): each as a
// child of the suite's session, in its process's reserve, taking its turn
// among the suite's calls, never a place of the pool of its own. The
// suite holds its place while it waits for its run, so a store call that
// asked the pool for one more could wait for ever once the pool is full
// (scripts/workerd-sandbox.ts). On-prem runs core in one isolate, so the
// run's call finds its test here by its run's ID; only the session's ID
// crosses to the sandbox, no I/O object.

/** A test's run's way into its suite's session (`holdFixtureRunSession`). */
export interface FixtureRunSession {
  /** The suite's session (its call ID), while it has one. */
  readonly parent: () => string | undefined;
  /** Runs `work` in its turn among the suite's calls. */
  readonly inTurn: <T>(work: () => Promise<T>) => Promise<T>;
}

const sessions = new Map<string, FixtureRunSession>();

/** Holds `session` as test run `runId`'s; the returned function lets go. */
export const holdFixtureRunSession = (
  runId: string,
  session: FixtureRunSession
): (() => void) => {
  sessions.set(runId, session);
  return () => {
    if (sessions.get(runId) === session) {
      sessions.delete(runId);
    }
  };
};

/** The suite's session test run `runId` reaches, if it reaches one. */
export const fixtureRunSessionOf = (
  runId: string
): FixtureRunSession | undefined => sessions.get(runId);
