import type { InstanceStatus } from "./contracts.ts";
import type { WorkflowRun } from "./run.ts";

export type RunStub = DurableObjectStub<WorkflowRun>;

export const notFound = (id: string): Error =>
  new Error(
    `instance.not_found: there is no workflow instance ${JSON.stringify(id)}`
  );

/** A run, as its caller holds it: Cloudflare Workflows' instance. */
export class WorkflowInstance {
  readonly id: string;
  readonly #stub: RunStub;

  constructor(id: string, stub: RunStub) {
    this.id = id;
    this.#stub = stub;
  }

  async status(): Promise<InstanceStatus> {
    const status = await this.#stub.status();
    if (status === undefined) {
      throw notFound(this.id);
    }
    return status;
  }
}
