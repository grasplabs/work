import type {
  App,
  AppRelease,
  AppVersion,
  AppVersionsApi,
  FileDiff,
  VersionReview,
} from "@grasp-os/shared/apps";

import { activateVersion } from "./app-activation.ts";
import {
  diffVersions,
  getVersion,
  listVersions,
  proposeVersion,
} from "./apps.ts";
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
import { reviewVersion } from "./version-review.ts";

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

  async propose(app: string, version: number): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await proposeVersion(this.#env, by, app, version)
    );
  }

  async review(app: string, version: number): Promise<VersionReview> {
    return await withPerson(
      this.#check,
      async (by) => await reviewVersion(this.#env, by, app, version)
    );
  }

  /**
   * Makes a version current through a verified candidate, over `expected`
   * when given (app-activation.ts, app-candidates.ts), then indexes the App into the Apps collection
   * (knowledge/apps-collection.ts): its entry holds the new version once
   * this returns, unless indexing failed or raced another; the clock
   * trigger then heals it within 15 minutes.
   */
  async setCurrent(
    app: string,
    version: number,
    expected?: number | null
  ): Promise<App> {
    return await withPerson(this.#check, async (by) => {
      const current = await activateVersion(
        this.#env,
        by,
        app,
        version,
        expected
      );
      await indexAppNow(this.#env, current.id);
      return current;
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
