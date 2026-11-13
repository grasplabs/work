import type { FileDiff } from "@grasp-os/shared/apps";
import type {
  LiveVersion,
  Version,
  VersionsApi,
} from "@grasp-os/shared/drafts";
import type { Subject } from "@grasp-os/shared/subject";

import { diffFiles } from "./apps.ts";
import { kinds, subjectOf } from "./drafts-rpc.ts";
import { rollback } from "./publish.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// A signed-in person's `versions`: each App's and workflow's versions,
// read as its kind reads them (`DraftKind.versions`), their files by
// their builders alone, and rolled back to (publish.ts).

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
      return await kinds[kind].versions.list(this.#env, by, id, before);
    });
  }

  async get(subject: Subject, version: number): Promise<Version> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      return await kinds[kind].versions.get(this.#env, by, id, version);
    });
  }

  /** Every file of `version`, exactly as published, for its builders. */
  async files(
    subject: Subject,
    version: number
  ): Promise<Record<string, string>> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      const found = await kinds[kind].readable(this.#env, by, id);
      return Object.fromEntries(
        await kinds[kind].versionFiles(this.#env, found, version)
      );
    });
  }

  async diff(subject: Subject, from: number, to: number): Promise<FileDiff[]> {
    return await withPerson(this.#check, async (by) => {
      const { kind, id } = subjectOf(subject);
      const found = await kinds[kind].readable(this.#env, by, id);
      const filesOf = async (version: number) =>
        await kinds[kind].versionFiles(this.#env, found, version);
      const [before, after] = await Promise.all([filesOf(from), filesOf(to)]);
      return diffFiles(before, after);
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
        kinds[kind],
        by,
        id,
        version,
        revision,
        expected
      );
    });
  }
}
