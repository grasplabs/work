import type { AppReview } from "@grasp-os/shared/app-review";
import type {
  AppVisitorEntry,
  AppVisitorGrants,
} from "@grasp-os/shared/app-visitors";
import type {
  App,
  AppAnswerer,
  AppChanges,
  AppContents,
  AppOverview,
  AppsApi,
  NewApp,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type {
  DataModelChange,
  DraftDataModel,
} from "@grasp-os/shared/data-model";
import type { DefinitionPackage } from "@grasp-os/shared/definition-packages";
import type { AppId } from "@grasp-os/shared/ids";

import { AppBlueprintsRpc } from "./app-blueprints.ts";
import { AppDataRpc } from "./app-data.ts";
import { AppIntegrationsRpc } from "./app-integrations.ts";
import { AppMembersRpc } from "./app-members.ts";
import { openAppLink, setAppLink } from "./app-own-links.ts";
import { AppPreviewRpc } from "./app-preview-rpc.ts";
import { AppReleasesRpc } from "./app-releases-rpc.ts";
import { removeApp } from "./app-removal.ts";
import { defineDraft, draftDataModel, reviewChanges } from "./app-review.ts";
import { resetAppData } from "./app-schema.ts";
import { appAnswerers, updateApp } from "./app-settings.ts";
import { setArchived } from "./app-status.ts";
import {
  appVisitorGrantsOf,
  setAppVisitorGrants,
} from "./app-visitor-grants.ts";
import { appVisitors, setAppVisitors } from "./app-visitors.ts";
import { AppWebhooksRpc } from "./app-webhooks.ts";
import {
  appContents,
  createApp,
  getApp,
  listAppOverviews,
  listApps,
} from "./apps.ts";
import { exportAppDefinition } from "./definition-export.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/**
 * A signed-in person's `apps`, with `apps.releases`,
 * `apps.members`, `apps.blueprints`, `apps.integrations`, `apps.webhooks`,
 * `apps.data` and `apps.preview`, in SessionRpc's form. An App's draft and
 * versions are every subject's (`drafts`, `versions`). The App
 * functions check the person's role in the App and validate what the
 * client sent.
 */
export class AppsRpc extends CoreRpcTarget implements AppsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  readonly #releases: AppReleasesRpc;
  readonly #members: AppMembersRpc;
  readonly #blueprints: AppBlueprintsRpc;
  readonly #integrations: AppIntegrationsRpc;
  readonly #webhooks: AppWebhooksRpc;
  readonly #data: AppDataRpc;
  readonly #preview: AppPreviewRpc;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#releases = new AppReleasesRpc(env, check);
    this.#members = new AppMembersRpc(env, check);
    this.#blueprints = new AppBlueprintsRpc(env, check);
    this.#integrations = new AppIntegrationsRpc(env, check);
    this.#webhooks = new AppWebhooksRpc(env, check);
    this.#data = new AppDataRpc(env, check);
    this.#preview = new AppPreviewRpc(env, check);
  }

  get releases(): AppReleasesRpc {
    return this.#releases;
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

  get webhooks(): AppWebhooksRpc {
    return this.#webhooks;
  }

  get data(): AppDataRpc {
    return this.#data;
  }

  get preview(): AppPreviewRpc {
    return this.#preview;
  }

  async review(app: string): Promise<AppReview> {
    return await withPerson(
      this.#check,
      async (by) => await reviewChanges(this.#env, by, app)
    );
  }

  async dataModel(app: string): Promise<DraftDataModel> {
    return await withPerson(
      this.#check,
      async (by) => await draftDataModel(this.#env, by, app)
    );
  }

  async define(
    app: string,
    operation: unknown,
    preview = false
  ): Promise<DataModelChange> {
    return await withPerson(
      this.#check,
      async (by) => await defineDraft(this.#env, by, app, operation, preview)
    );
  }

  async create(app: NewApp): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await createApp(this.#env, by, app)
    );
  }

  async list(): Promise<ViewedApp[]> {
    return await withPerson(
      this.#check,
      async (by) => await listApps(this.#env, by)
    );
  }

  async get(app: string): Promise<ViewedApp> {
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

  async overview(): Promise<AppOverview[]> {
    return await withPerson(
      this.#check,
      async (by) => await listAppOverviews(this.#env, by)
    );
  }

  async archive(app: string): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await setArchived(this.#env, by, app, true)
    );
  }

  async resetData(app: string, name: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await resetAppData(this.#env, by, app, name);
    });
  }

  async restore(app: string): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await setArchived(this.#env, by, app, false)
    );
  }

  async setLink(app: string, link: string | null): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await setAppLink(this.#env, by, app, link)
    );
  }

  async visitors(app: string): Promise<AppVisitorEntry[]> {
    return await withPerson(
      this.#check,
      async (by) => await appVisitors(this.#env, by, app)
    );
  }

  async setVisitors(
    app: string,
    list: AppVisitorEntry[]
  ): Promise<AppVisitorEntry[]> {
    return await withPerson(
      this.#check,
      async (by) => await setAppVisitors(this.#env, by, app, list)
    );
  }

  async visitorGrants(app: string): Promise<AppVisitorGrants> {
    return await withPerson(
      this.#check,
      async (by) => await appVisitorGrantsOf(this.#env, by, app)
    );
  }

  async setVisitorGrants(
    app: string,
    functions: string[]
  ): Promise<AppVisitorGrants> {
    return await withPerson(
      this.#check,
      async (by) => await setAppVisitorGrants(this.#env, by, app, functions)
    );
  }

  async openLink(link: string): Promise<{ app: AppId }> {
    return await withPerson(
      this.#check,
      async (by) => await openAppLink(this.#env, by, link)
    );
  }

  async update(app: string, changes: AppChanges): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await updateApp(this.#env, by, app, changes)
    );
  }

  async remove(app: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await removeApp(this.#env, by, app);
    });
  }

  async answerers(app: string): Promise<AppAnswerer[]> {
    return await withPerson(
      this.#check,
      async (by) => await appAnswerers(this.#env, by, app)
    );
  }

  async definition(app: string): Promise<DefinitionPackage> {
    return await withPerson(
      this.#check,
      async (by) => await exportAppDefinition(this.#env, by, app)
    );
  }
}
