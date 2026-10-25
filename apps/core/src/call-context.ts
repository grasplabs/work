import { AsyncLocalStorage } from "node:async_hooks";

import type { CallHook, TargetCall } from "@grasp-os/shared/rpc-target";

// Which call of a target a method runs for: noted around every call that
// arrives over `/rpc` (rpc-target.ts, `CoreRpcTarget`), so what the method
// asks for on its way (its session check: staff-audit.ts) knows the
// surface it serves.

const calls = new AsyncLocalStorage<TargetCall>();

/** What every call of every target runs inside: its call, noted. */
export const noteCall: CallHook = (call, run) => calls.run(call, run);

/** The call running now, if a target's method is running. */
export const currentCall = (): TargetCall | undefined => calls.getStore();
