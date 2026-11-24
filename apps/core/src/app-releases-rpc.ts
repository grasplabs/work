import type { AppRelease, AppReleasesApi } from "@grasp-os/shared/apps";

import {
  holdAppRelease,
  liftAppReleaseHold,
  listReleases,
  revokeAppRelease,
} from "./release-controls.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/** A signed-in person's `apps.releases` (release-controls.ts). */
export class AppReleasesRpc extends CoreRpcTarget implements AppReleasesApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(app: string, before?: number): Promise<AppRelease[]> {
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
