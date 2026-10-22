// Tests only: a random delay where a JSON workflow's host does I/O of its
// own between the run's code asking for a step and the engine hearing of
// it (resource-host.ts: the check of the run's person, the wait for one
// of the run's attempt slots). Local D1 answers in well under a
// macrotask, which hid replays that only held together while the host
// was that quick; `WORKFLOW_HOST_LATENCY_MS` lets the tests put a
// deployment's latency back. Honoured only where `SANDBOX_IN_PROCESS` is
// `unbounded`, which only tests and local development set, so no
// deployment can slow its runs with it.

/** The longest delay the setting may ask for, in milliseconds. */
const maxLatencyMs = 1000;

/** No delay: what every deployment gets. */
const none = async (): Promise<void> => {
  // Nothing to wait for.
};

/**
 * The host's delay: up to `WORKFLOW_HOST_LATENCY_MS` milliseconds, at
 * random each time, where the tests set it; none anywhere else.
 */
export const hostLatency = (
  env: Pick<Env, "SANDBOX_IN_PROCESS" | "WORKFLOW_HOST_LATENCY_MS">
): (() => Promise<void>) => {
  const most = Number(env.WORKFLOW_HOST_LATENCY_MS);
  if (
    env.SANDBOX_IN_PROCESS !== "unbounded" ||
    !Number.isFinite(most) ||
    most <= 0 ||
    most > maxLatencyMs
  ) {
    return none;
  }
  return async () => {
    await scheduler.wait(Math.random() * most);
  };
};
