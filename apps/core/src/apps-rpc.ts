import type {
  App,
  AppChanges,
  AppContents,
  AppsApi,
  CurrentExports,
  NewApp,
} from "@grasp-os/shared/apps";
import type { DefinitionPackage } from "@grasp-os/shared/definition-packages";

import { AppBlueprintsRpc } from "./app-blueprints.ts";
import { AppFilesRpc } from "./app-files-rpc.ts";
import { AppIntegrationsRpc } from "./app-integrations.ts";
import { AppMembersRpc } from "./app-members.ts";
import { updateApp } from "./app-settings.ts";
import { changeStatus } from "./app-status.ts";
import type { AppTransition } from "./app-status.ts";
import { AppVersionsRpc } from "./app-versions-rpc.ts";
import {
  appContents,
  appExports,
  createApp,
  getApp,
  listApps,
} from "./apps.ts";
import { exportAppDefinition } from "./definition-export.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/**
 * A signed-in person's `apps`, with `apps.files`, `apps.versions`,
 * `apps.members`, `apps.blueprints` and `apps.integrations`, in SessionRpc's form. The App
 * functions check the person's role in the App and validate what the
 * client sent.
 */
export class AppsRpc extends CoreRpcTarget implements AppsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  readonly #files: AppFilesRpc;
  readonly #versions: AppVersionsRpc;
  readonly #members: AppMembersRpc;
  readonly #blueprints: AppBlueprintsRpc;
  readonly #integrations: AppIntegrationsRpc;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#files = new AppFilesRpc(env, check);
    this.#versions = new AppVersionsRpc(env, check);
    this.#members = new AppMembersRpc(env, check);
    this.#blueprints = new AppBlueprintsRpc(env, check);
    this.#integrations = new AppIntegrationsRpc(env, check);
  }

  get files(): AppFilesRpc {
    return this.#files;
  }

  get versions(): AppVersionsRpc {
    return this.#versions;
  }

  get members(): AppMembersRpc {
    return this.#members;
  }

  get blueprints(): AppBlueprintsRpc {
    return this.#blueprints;
  }

  get integrations(): AppIntegrationsRpc {
    return this.#integrations;
  }

  async create(app: NewApp): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await createApp(this.#env, by, app)
    );
  }

  async list(): Promise<App[]> {
    return await withPerson(
      this.#check,
      async (by) => await listApps(this.#env, by)
    );
  }

  async get(app: string): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await getApp(this.#env, by, app)
    );
  }

  async contents(app: string): Promise<AppContents> {
    return await withPerson(
      this.#check,
      async (by) => await appContents(this.#env, by, app)
    );
  }

  async exports(app: string): Promise<CurrentExports> {
    return await withPerson(
      this.#check,
      async (by) => await appExports(this.#env, by, app)
    );
  }

  async publish(app: string): Promise<App> {
    return await this.#changeStatus(app, "publish");
  }

  async unpublish(app: string): Promise<App> {
    return await this.#changeStatus(app, "unpublish");
  }

  async archive(app: string): Promise<App> {
    return await this.#changeStatus(app, "archive");
  }

  async restore(app: string): Promise<App> {
    return await this.#changeStatus(app, "restore");
  }

  async #changeStatus(app: string, transition: AppTransition): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await changeStatus(this.#env, by, app, transition)
    );
  }

  async update(app: string, changes: AppChanges): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await updateApp(this.#env, by, app, changes)
    );
  }

  async definition(app: string): Promise<DefinitionPackage> {
    return await withPerson(
      this.#check,
      async (by) => await exportAppDefinition(this.#env, by, app)
    );
  }
}
