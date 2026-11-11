import type { ReadRequest, WriteRequest } from "@grasp-os/shared/store-reads";

import type { PeopleFunctionName } from "./people.ts";
import type { FunctionKind } from "./server-function.ts";

/**
 * What the host hands the runner for one invocation: methods only, so it
 * can be an RPC stub, and it stops working once the invocation ends.
 */
export interface FunctionChannel {
  /** One read of the App's store. */
  readonly read: (request: ReadRequest) => Promise<unknown>;
  /** One staged write: a mutation's only. Answers an insert's minted ID. */
  readonly write: (request: WriteRequest) => Promise<unknown>;
  /**
   * A call of another of the App's functions, by the kind the caller
   * expects (`runQuery`, `runMutation`, `runAction`) and its registered
   * path: the host refuses another kind.
   */
  readonly call: (
    kind: FunctionKind,
    path: string,
    args: unknown
  ) => Promise<unknown>;
  /**
   * One call of one of the App's permissions: an action's only, but a
   * mutation's staged start (`start`) or sent event (`sendEvent`) of one
   * of the App's workflows, and either's send to people (`peopleAlias`).
   */
  readonly resource: (
    alias: string,
    method: string,
    args: unknown
  ) => Promise<unknown>;
  /**
   * One progress snapshot of a streaming action, for the
   * page that runs it: a streaming action's only.
   */
  readonly emit: (progress: unknown) => Promise<unknown>;
  /**
   * One read of who calls (`caller`) or of the organization's people
   * (people.ts), which the host answers from its own record of the
   * caller, whatever the arguments say about anyone.
   */
  readonly people: (name: PeopleFunctionName, args: object) => Promise<unknown>;
}
