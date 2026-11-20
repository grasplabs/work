import { releaseFormatVersion } from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { findVersion, readStored } from "../src/apps.ts";
import { boundIn, publishApp } from "./app-definitions.ts";
import { rewrite } from "./app-releases-harness.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  jobEventsContract,
  jobEventsDeclared,
  jobWaitingOf,
  jsonWorkflowAppsOf,
  requestsApp,
} from "./json-workflow-apps.ts";
import { failure } from "./sealed-apps.ts";
import { outcome, unique } from "./sign-in.ts";
import { publishOverRpc } from "./workflow-publishing.ts";

// A workflow bound from an App's draft (`bindWorkflow`) is recorded with
// the App version the draft becomes, and bound as that version is made
// current, in the same switch, never before (app-workflow-bindings.ts);
// like any binding, its starts run the workflow's live version. These
// tests start from the ways that can fail: a roll back by someone with
// no role in a workflow the older version binds; the version's
// declaration and the workflow's live version no longer agreeing; and a
// roll back leaving the App's pages and its starts on different
// workflows.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

type Person = Awaited<ReturnType<typeof signedIn>>;

/**
 * A workflow of `owner`'s, live at a version of the events contract
 * `events` as the App declares it (`jobEventsDeclared`), shared with
 * `builders` as users.
 */
const declaredWorkflow = async (
  owner: Person,
  events: string,
  builders: readonly Person[] = []
): Promise<string> => {
  const api = owner.api.workflowResources;
  const flow = await api.create(`bound-${unique()}`);
  await publishOverRpc(owner.api, flow.id, jobWaitingOf(events));
  for (const builder of builders) {
    // oxlint-disable-next-line no-await-in-loop -- one share at a time
    await api.members.add(flow.id, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
  }
  return flow.id;
};

/**
 * Binds workflow `workflow` under `review` in App `app`'s draft, as `by`,
 * and publishes it: the version it went live as.
 */
const rebound = async (
  by: Person,
  app: string,
  workflow: string
): Promise<number> => {
  const read = await by.api.drafts.get({ kind: "app", id: app });
  await by.api.apps.define(app, read.revision, {
    op: "bindWorkflow",
    alias: "review",
    workflow,
  });
  const { version } = await by.api.drafts.publish(
    { kind: "app", id: app },
    read.revision + 1
  );
  return version;
};

/** What App `app` binds, by alias, as its builder `person` reads it. */
const boundOf = async (person: Person, app: string) => {
  const listed = await person.api.workflowResources.appBindings(app);
  return Object.fromEntries(
    listed.map(({ alias, workflowId }) => [alias, workflowId])
  );
};

/** Which workflow version `version` of App `app`'s release seals, by alias. */
const sealedOf = async (app: string, version: number) => {
  const sealed = await loadRelease(env, appIdSchema.parse(app), version);
  return Object.fromEntries(
    sealed.workflows.map(({ alias, workflowId }) => [alias, workflowId])
  );
};

/**
 * Rewrites the stored definition of `version` of App `app` as a version
 * stored before bindings named only their workflow held it, each binding
 * pinning the workflow's version: its new hash.
 */
const pinnedEarlier = async (app: AppId, version: number): Promise<string> => {
  const { definition } = await findVersion(env, app, version);
  const stored = z
    .looseObject({ workflowBindings: z.array(z.looseObject({})) })
    .parse(JSON.parse(definition ?? "{}"));
  const text = JSON.stringify({
    ...stored,
    workflowBindings: stored.workflowBindings.map((binding) => ({
      ...binding,
      version: 1,
    })),
  });
  const hash = await sha256Hex(text);
  // Written once and never changed (migration 0228's trigger): as storage
  // could, the trigger set aside for the rewrite.
  const trigger = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'app_versions_definition_immutable'"
  ).first<{ sql: string }>();
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER app_versions_definition_immutable"),
    env.DB.prepare(
      "UPDATE app_versions SET definition = ?, definition_hash = ? WHERE app_id = ? AND version = ?"
    ).bind(text, hash, app, version),
    env.DB.prepare(trigger?.sql ?? ""),
  ]);
  return hash;
};

describe(
  "a workflow binding recorded with an App version",
  { timeout: 180_000 },
  () => {
    it("binds as its version goes live, its release sealing the same workflow for its pages, audited with the App version, and a roll back binds what the older version sealed again", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const events = await jobEventsContract(admin);
      const first = await declaredWorkflow(builder, events);
      const then = await declaredWorkflow(builder, events);
      const { id: app } = await builder.api.apps.create({ name: "Requests" });
      const { version: current } = await publishApp(
        builder.api,
        app,
        boundIn(requestsApp("review", jobEventsDeclared), { review: first })
      );
      const before = await boundOf(builder, app);

      const proposed = await rebound(builder, app, then);
      const after = await boundOf(builder, app);
      const recorded = await allEvents();
      const audited = recorded
        .filter(
          ({ action, target, detail }) =>
            action === "workflow.app_binding.bound" &&
            target?.id === app &&
            detail.appVersion === proposed
        )
        .map(({ detail }) => ({
          workflowId: detail.workflowId,
          replacedWorkflowId: detail.replacedWorkflowId,
        }));
      await builder.api.versions.rollback({ kind: "app", id: app }, current);

      expect({
        before,
        after,
        sealed: await sealedOf(app, proposed),
        audited,
        rolledBack: await boundOf(builder, app),
      }).toStrictEqual({
        before: { review: first },
        after: { review: then },
        sealed: { review: then },
        audited: [{ workflowId: then, replacedWorkflowId: first }],
        rolledBack: { review: first },
      });
    });

    it("refuses a version from before bindings named only their workflow as one to publish again, and publishes the App again from a draft that starts its definition anew", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const events = await jobEventsContract(admin);
      const first = await declaredWorkflow(builder, events);
      const { id } = await builder.api.apps.create({ name: "Requests" });
      const app = appIdSchema.parse(id);
      const source = boundIn(requestsApp("review", jobEventsDeclared), {
        review: first,
      });
      await publishApp(builder.api, app, source);
      // As version 1 was stored and sealed before: its definition pinning
      // the workflow's version, its release of the format before.
      const pinned = await pinnedEarlier(app, 1);
      await rewrite(app, await loadRelease(env, app, 1), {
        contracts: (contracts) => {
          contracts.formatVersion = 6;
          contracts.workflows = {
            review: {
              alias: "review",
              pinned: { workflowId: first, version: 1 },
            },
          };
        },
        manifest: (manifest) => {
          manifest.formatVersion = releaseFormatVersion - 1;
          manifest.definitionHash = pinned;
        },
      });
      const refused = {
        release: await failure(async () => await loadRelease(env, app, 1)),
        definition: await failure(
          async () => await readStored(await findVersion(env, app, 1))
        ),
      };

      // Its draft reads, and starts its definition anew: the builder
      // writes the App again and publishes it.
      const draft = await builder.api.drafts.get({ kind: "app", id: app });
      const { version } = await publishApp(builder.api, app, source);

      expect({
        refused,
        draftBase: draft.base,
        version,
        sealed: await sealedOf(app, version),
        bound: await boundOf(builder, app),
      }).toStrictEqual({
        refused: {
          release: "version.format_unsupported",
          definition: "app.definition_outdated",
        },
        draftBase: 1,
        version: 2,
        sealed: { review: first },
        bound: { review: first },
      });
    });

    it("refuses a roll back by someone with no role in a workflow the older version binds, leaving the version live and its binding", async () => {
      const [admin, owner, author] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
        signedIn("builder"),
      ]);
      const events = await jobEventsContract(admin);
      const first = await declaredWorkflow(owner, events);
      const then = await declaredWorkflow(owner, events, [author]);
      const { id: app } = await owner.api.apps.create({ name: "Requests" });
      await owner.api.apps.members.add(app, {
        type: "person",
        id: author.userId,
        role: "builder",
      });
      const { version: older } = await publishApp(
        owner.api,
        app,
        boundIn(requestsApp("review", jobEventsDeclared), { review: first })
      );
      const live = await rebound(author, app, then);

      const refused = await outcome(
        author.api.versions.rollback({ kind: "app", id: app }, older)
      );
      const { currentVersion } = await owner.api.apps.get(app);

      expect({
        refused,
        currentVersion,
        bound: await boundOf(owner, app),
      }).toStrictEqual({
        refused: "workflow.app_version_binding_unavailable",
        currentVersion: live,
        bound: { review: then },
      });
    });

    it("refuses a roll back to a version declaring what the workflow it binds no longer has live", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const events = await jobEventsContract(admin);
      const first = await declaredWorkflow(builder, events);
      const then = await declaredWorkflow(builder, events);
      const { id: app } = await builder.api.apps.create({ name: "Requests" });
      const { version: older } = await publishApp(
        builder.api,
        app,
        boundIn(requestsApp("review", jobEventsDeclared), { review: first })
      );
      const live = await rebound(builder, app, then);
      // Bound by no App now, the first workflow goes live waiting for
      // another event in place of the one version 1 declares.
      await publishOverRpc(
        builder.api,
        first,
        jobWaitingOf(events, { task: "awaitJob" })
      );

      const refused = await outcome(
        builder.api.versions.rollback({ kind: "app", id: app }, older)
      );
      const { currentVersion } = await builder.api.apps.get(app);

      expect({
        refused,
        currentVersion,
        bound: await boundOf(builder, app),
      }).toStrictEqual({
        refused: "workflow.app_binding_contract_changed",
        currentVersion: live,
        bound: { review: then },
      });
    });
  }
);
