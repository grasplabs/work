// The engine's own log lines, in the shape Workers Logs searches: one
// object per line, an event name and its fields. Only for what the engine
// recovers from on its own, so a failure it swallows still leaves a trace.
// Nothing of a run's params, results or errors goes in: only the storage
// call's own error.

/** A storage failure the run recovers from, logged once, where it is met. */
export const warnRecovered = (event: string, error: unknown): void => {
  console.warn({
    event,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : undefined,
  });
};
