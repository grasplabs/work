// A run object whose host set a replay bound no replay could keep: it
// refuses to start any run (run.ts).
import type {
  DefinitionIdentity,
  WorkflowDefinition,
} from "../src/contracts.ts";
import { WorkflowRun } from "../src/run.ts";

export class MisconfiguredRuns extends WorkflowRun {
  protected override readonly rollbackReplayMs = 0;

  // oxlint-disable-next-line class-methods-use-this -- no run of it ever starts
  protected definition(
    _identity: DefinitionIdentity
  ): WorkflowDefinition | undefined {
    return undefined;
  }
}
