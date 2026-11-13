import type { FileDiff } from "@grasp-os/shared/apps";
import type {
  LiveVersion,
  Version,
  VersionsApi,
} from "@grasp-os/shared/drafts";
import type { Identity } from "@grasp-os/shared/rpc";
import type { Subject, SubjectKind } from "@grasp-os/shared/subject";

import { diffVersions, getVersion, listVersions } from "./apps.ts";
import { publishables, subjectOf } from "./drafts-rpc.ts";
import { rollback } from "./publish.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  diffWorkflowVersions,
  workflowVersion,
  workflowVersions,
} from "./workflow-resources.ts";

// A signed-in person's `versions`: each App's and workflow's versions,
// read as its kind reads them (apps.ts, workflow-resources.ts), and
// rolled back to (publish.ts).

/** How a kind of subject reads its versions, for `by`. */
interface VersionReader {
  list: (
    env: Env,
    by: Identity,
    id: string,
    before?: number
  ) => Promise<Version[]>;
  get: (
    env: Env,
    by: Identity,
    id: string,
    version: number
  ) => Promise<Version>;
  diff: (
    env: Env,
    by: Identity,
    id: string,
    from: number,
    to: number
  ) => Promise<FileDiff[]>;
}

/** How each kind of subject reads its versions. */
const readers: Readonly<Record<SubjectKind, VersionReader>> = {
  app: { list: listVersions, get: getVersion, diff: diffVersions },
  workflow: {
    list: workflowVersions,
    get: workflowVersion,
    diff: diffWorkflowVersions,
  },
};

/** A signed-in person's `versions`. */
export class VersionsRpc extends CoreRpcTarget implements VersionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(subject: Subject, before?: number): Promise<Version[]> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      return await readers[kind].list(this.#env, by, id, before);
    });
  }

  async get(subject: Subject, version: number): Promise<Version> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      return await readers[kind].get(this.#env, by, id, version);
    });
  }

  async diff(subject: Subject, from: number, to: number): Promise<FileDiff[]> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      return await readers[kind].diff(this.#env, by, id, from, to);
    });
  }

  /**
   * Makes `version` live again, to roll back to it (or a version never
   * live, such as the first of an App created from a blueprint), over
   * `expected` when given, the draft reset to it over `revision`
   * (publish.ts, `rollback`).
   */
  async rollback(
    subject: Subject,
    version: number,
    revision?: number,
    expected?: number | null
  ): Promise<LiveVersion> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      return await rollback(
        this.#env,
        publishables[kind],
        by,
        id,
        version,
        revision,
        expected
      );
    });
  }
}
