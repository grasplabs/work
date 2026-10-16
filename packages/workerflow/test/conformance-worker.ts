// oxlint-disable max-classes-per-file -- the two engines' classes, side by side
// The conformance Worker: the same definitions (conformance-fixtures.ts) on two engines
// in one workerd. ENGINE is Workerflow's run object; REFERENCE is the
// Workflows engine Wrangler ships (miniflare's, pinned in the catalog),
// which runs a WorkflowEntrypoint. The entrypoint is the spec's "tiny
// import adapter": it finds the fixture the params name and runs it with
// the reference's own event and step.
import { WorkflowEntrypoint } from "cloudflare:workers";
import type {
  WorkflowEvent as ReferenceEvent,
  WorkflowStep as ReferenceStep,
} from "cloudflare:workers";

import type {
  DefinitionIdentity,
  WorkflowDefinition,
  WorkflowStep,
} from "../src/contracts.ts";
import { WorkflowRun } from "../src/run.ts";
import { fixtures } from "./conformance-fixtures.ts";

/** What a reference run is created with: the fixture, and its params. */
export interface ReferenceParams {
  readonly fixture: string;
  readonly params: unknown;
}

export class EngineRuns extends WorkflowRun {
  // oxlint-disable-next-line class-methods-use-this -- the fixtures are the module's
  protected definition({
    definition,
  }: DefinitionIdentity): WorkflowDefinition | undefined {
    return fixtures[definition];
  }
}

export class ReferenceFlow extends WorkflowEntrypoint<
  Cloudflare.Env,
  ReferenceParams
> {
  // oxlint-disable-next-line class-methods-use-this -- the fixtures are the module's
  override async run(
    event: Readonly<ReferenceEvent<ReferenceParams>>,
    step: ReferenceStep
  ): Promise<unknown> {
    const fixture = fixtures[event.payload.fixture];
    if (fixture === undefined) {
      throw new Error(`no fixture ${event.payload.fixture}`);
    }
    // SAFETY: the reference's step has every method Workerflow's has, with
    // the same arguments and results; only their types differ, where the
    // context-type discrepancy (conformance-families.ts) says. Workerflow's
    // context also promises an idempotencyKey, which no fixture reads.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const shared: WorkflowStep = step as never;
    // The reference's event as it is, its payload the fixture's params.
    return await fixture.run(
      { ...event, payload: event.payload.params },
      shared
    );
  }
}

export default {
  fetch: (): Response => new Response(null, { status: 404 }),
};
