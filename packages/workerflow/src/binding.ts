// How a caller reaches its runs: the Workflow binding's create and get, and
// an instance's status, in Cloudflare Workflows' shapes. Each run is its own
// object in the namespace given, named from the definition and instance ID
// (identity.ts). Where its data lives is the namespace's to say: pass one
// scoped with `jurisdiction("eu")` to create runs in the EU.
import { encode } from "./codec.ts";
import {
  assertInstanceId,
  maxStartKeyLength,
  runObjectName,
} from "./identity.ts";
import { notFound, WorkflowInstance } from "./instance.ts";
import type { RunStub } from "./instance.ts";
import type { StartOutcome, WorkflowRun } from "./run.ts";

type RunNamespace = DurableObjectNamespace<WorkflowRun>;

const alreadyExists = (id: string): Error =>
  new Error(
    `instance.already_exists: a workflow instance ${JSON.stringify(id)} exists already`
  );

export interface Admission<Params> {
  id: string;
  params?: Params;
  /**
   * What makes this start this start: the same key again (a redelivered
   * trigger, a retry after an answer that never came) finds the run it
   * created instead of failing or creating another.
   */
  key: string;
}

export class Workflow<Params = unknown> {
  readonly #namespace: RunNamespace;
  readonly #definition: string;
  readonly #version: string | null;

  constructor(
    namespace: RunNamespace,
    definition: string,
    options: { version?: string } = {}
  ) {
    this.#namespace = namespace;
    this.#definition = definition;
    this.#version = options.version ?? null;
  }

  #stub(id: string): RunStub {
    return this.#namespace.get(
      this.#namespace.idFromName(runObjectName(this.#definition, id))
    );
  }

  async #start(
    id: string,
    params: Params | undefined,
    key: string
  ): Promise<StartOutcome> {
    // Encoded here, so a value the journal can't keep fails the caller
    // before any run exists.
    const encoded = encode(params);
    return await this.#stub(id).start({
      definition: this.#definition,
      version: this.#version,
      instanceId: id,
      params: encoded,
      key,
    });
  }

  /**
   * Creates a run, as Cloudflare Workflows' `create` does: an ID that
   * exists already is an error, even when it is this same call's. For a
   * start that may be delivered again, use `admit`.
   */
  async create(
    options: { id?: string; params?: Params } = {}
  ): Promise<WorkflowInstance> {
    const id = assertInstanceId(options.id ?? crypto.randomUUID());
    const outcome = await this.#start(id, options.params, crypto.randomUUID());
    if (outcome !== "created") {
      throw alreadyExists(id);
    }
    return new WorkflowInstance(id, this.#stub(id));
  }

  /**
   * Creates a run that may be asked for more than once: the same `key`,
   * ID and params find the run the first delivery created, whether or not
   * that delivery heard back. A different key under the same ID is another
   * start, and an error.
   */
  async admit(
    admission: Admission<Params>
  ): Promise<{ instance: WorkflowInstance; created: boolean }> {
    const id = assertInstanceId(admission.id);
    const { key } = admission;
    if (key.length === 0 || key.length > maxStartKeyLength) {
      throw new TypeError(
        `A start key is 1 to ${maxStartKeyLength} characters long`
      );
    }
    const outcome = await this.#start(id, admission.params, key);
    switch (outcome) {
      case "created":
      case "existing": {
        return {
          instance: new WorkflowInstance(id, this.#stub(id)),
          created: outcome === "created",
        };
      }
      case "conflict": {
        throw new Error(
          `The start ${JSON.stringify(key)} of workflow instance ${JSON.stringify(id)} was made with other params`
        );
      }
      case "collision": {
        throw alreadyExists(id);
      }
      default: {
        throw new Error(`Unknown start outcome: ${String(outcome)}`);
      }
    }
  }

  async get(id: string): Promise<WorkflowInstance> {
    const stub = this.#stub(assertInstanceId(id));
    if ((await stub.status()) === undefined) {
      throw notFound(id);
    }
    return new WorkflowInstance(id, stub);
  }
}
