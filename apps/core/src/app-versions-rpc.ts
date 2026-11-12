import type {
  App,
  AppRelease,
  AppVersion,
  AppVersionsApi,
  FileDiff,
} from "@grasp-os/shared/apps";

import { publishVersion } from "./app-publish.ts";
import { diffVersions, getVersion, listVersions } from "./apps.ts";
import { indexAppNow } from "./knowledge/apps-collection.ts";
import {
  holdAppRelease,
  liftAppReleaseHold,
  listReleases,
  revokeAppRelease,
} from "./release-controls.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/** A signed-in person's `apps.versions`. */
export class AppVersionsRpc extends CoreRpcTarget implements AppVersionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(app: string, before?: number): Promise<AppVersion[]> {
    return await withPerson(
      this.#check,
      async (by) => await listVersions(this.#env, by, app, before)
    );
  }

  async get(app: string, version: number): Promise<AppVersion> {
    return await withPerson(
      this.#check,
      async (by) => await getVersion(this.#env, by, app, version)
    );
  }

  async diff(app: string, from: number, to: number): Promise<FileDiff[]> {
    return await withPerson(
      this.#check,
      async (by) => await diffVersions(this.#env, by, app, from, to)
    );
  }

  /**
   * Publishes one of the App's versions again, to roll back to it (or a
   * version never live), over `expected` when given, the draft reset to
   * it over `revision` (app-publish.ts, `publishVersion`), then indexes
   * the App into the Apps collection (knowledge/apps-collection.ts): its
   * entry holds the live version once this returns, unless indexing
   * failed or raced another; the clock trigger then heals it within 15
   * minutes.
   */
  async publish(
    app: string,
    version: number,
    revision?: number,
    expected?: number | null
  ): Promise<App> {
    return await withPerson(this.#check, async (by) => {
      const live = await publishVersion(
        this.#env,
        by,
        app,
        version,
        revision,
        expected
      );
      await indexAppNow(this.#env, live.id);
      return live;
    });
  }

  async releases(app: string, before?: number): Promise<AppRelease[]> {
    return await withPerson(
      this.#check,
      async (by) => await listReleases(this.#env, by, app, before)
    );
  }

  async revoke(
    app: string,
    version: number,
    input: unknown
  ): Promise<AppRelease> {
    return await withPerson(
      this.#check,
      async (by) => await revokeAppRelease(this.#env, by, app, version, input)
    );
  }

  async placeHold(
    app: string,
    version: number,
    input: unknown
  ): Promise<AppRelease> {
    return await withPerson(
      this.#check,
      async (by) => await holdAppRelease(this.#env, by, app, version, input)
    );
  }

  async releaseHold(
    app: string,
    version: number,
    hold: string
  ): Promise<AppRelease> {
    return await withPerson(
      this.#check,
      async (by) => await liftAppReleaseHold(this.#env, by, app, version, hold)
    );
  }
}
