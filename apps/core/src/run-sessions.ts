// The sandbox session each Code Mode run holds on-prem, by the run's ID,
// while it's open: an App function the run calls (env.apps.call) runs in
// a child of it, which the supervisor gives a process of the run's own
// reserve, so the call never waits for a process the run holds while the
// run waits for it (scripts/workerd-sandbox.ts). Core's APIs are loopback
// stubs of this Worker, which on-prem runs in one isolate, so the API a
// run calls finds its session here; only its ID crosses, no I/O object.

const sessions = new Map<string, string>();

/** Holds `callId` as run `key`'s session; the returned function lets go. */
export const holdRunSession = (key: string, callId: string): (() => void) => {
  sessions.set(key, callId);
  return () => {
    if (sessions.get(key) === callId) {
      sessions.delete(key);
    }
  };
};

/** The session (its call ID) run `key` holds now, if it holds one. */
export const runSessionOf = (key: string): string | undefined =>
  sessions.get(key);
