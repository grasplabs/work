// The ask of a run's code that a host is handling, as the host makes calls
// of the engine's step API for it. An independent workflow's host
// (resource-host.ts) does I/O of its own between its run's code asking for
// a step and calling the step API (the check of the run's person, the step
// counting's own hashing), and says the run busy meanwhile (workerflow's
// `step.busy`), so the engine doesn't suspend the run while a call is on
// its way to it. It needs to know the moment the call is made, which only
// the innermost step does (`runStepOf`, dispatcher.ts): the ask rides in
// the async context, so no step in between (`countedStep`, host.ts) has to
// pass it on.
import { AsyncLocalStorage } from "node:async_hooks";

/** An ask a host handles, told when its engine calls are made and back. */
export interface EngineAsk {
  /** A call of the engine's step API for it was just made. */
  readonly made: () => void;
  /** That call came back: the host handles the ask again. */
  readonly back: () => void;
}

/** The ask being handled, in the async context of the host's work on it. */
export const engineAsks = new AsyncLocalStorage<EngineAsk>();

/**
 * Makes `call`, a call of the engine's step API, telling the ask being
 * handled, if any, once it is made and once it is back.
 */
export const engineCall = async <T>(call: () => Promise<T>): Promise<T> => {
  const ask = engineAsks.getStore();
  const made = call();
  ask?.made();
  try {
    return await made;
  } finally {
    ask?.back();
  }
};
