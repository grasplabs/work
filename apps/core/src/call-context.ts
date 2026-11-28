import { AsyncLocalStorage } from "node:async_hooks";

import type { CallHook, TargetCall } from "@grasp-os/shared/rpc-target";

// Which call of a target a method runs for: noted around every call that
// arrives over `/rpc` (rpc-target.ts, `CoreRpcTarget`), so what the method
// asks for on its way (its session check: staff-audit.ts) knows the
// surface it serves.
//
// And the one place every call answers through: a call that read the
// connection's session on its way (rpc.ts registers it, `checkedInCall`)
// checks it again before its answer goes back, so a call that ran longer
// than a reading holds never answers someone whose session ended
// meanwhile, whichever namespace or method it is. Free while the reading
// is fresh: every check of a connection shares it.

/** A call running, and what checks its answer before it goes back. */
interface RunningCall {
  call: TargetCall;
  verifiers: Set<() => Promise<void>>;
}

const calls = new AsyncLocalStorage<RunningCall>();

/** Runs every check the call asked for; throws as the first that refuses. */
const verified = async (
  verifiers: ReadonlySet<() => Promise<void>>,
  answer: unknown
): Promise<unknown> => {
  const value: unknown = await answer;
  for (const verify of verifiers) {
    // oxlint-disable-next-line no-await-in-loop -- one after the other, rarely more than one
    await verify();
  }
  return value;
};

/**
 * What every call of every target runs inside: its call, noted, and its
 * answer checked by what it registered (`checkedInCall`).
 */
export const noteCall: CallHook = (call, run) => {
  const verifiers = new Set<() => Promise<void>>();
  return calls.run({ call, verifiers }, () => {
    const answer = run();
    // A call that read no session (signed out, `ping`) answers as it is.
    return verifiers.size === 0 && !(answer instanceof Promise)
      ? answer
      : verified(verifiers, answer);
  });
};

/** The call running now, if a target's method is running. */
export const currentCall = (): TargetCall | undefined => calls.getStore()?.call;

/**
 * Has the call running now, if one is, run `verify` before its answer
 * goes back: what a connection's session check registers (rpc.ts).
 */
export const checkedInCall = (verify: () => Promise<void>): void => {
  calls.getStore()?.verifiers.add(verify);
};
