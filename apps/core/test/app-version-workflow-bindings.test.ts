import { chatIdSchema, appIdSchema } from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { publishVersion } from "../src/app-publish.ts";
import { loadRelease } from "../src/app-releases.ts";
import { commitApp } from "./app-definitions.ts";
import { racingDb, release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  jobEventsContract,
  jobEventsDeclared,
  jobWaitingOf,
  jsonWorkflowAppsOf,
  requestsApp,
} from "./json-workflow-apps.ts";
import { outcome, unique } from "./sign-in.ts";

// A workflow version bound from an App's draft (`bindWorkflow`) is
// recorded with the App version the draft becomes, and bound as that
// version is made current, in the same switch, never before
// (app-workflow-bindings.ts). These tests start from the ways that can
// fail: the person who bound it loses their role in the workflow, or
// whoever makes the version current has none; the workflow is deleted, or
// the App version unpublished, between the check and the switch; the
// version's declaration and the version it binds no longer agree (a
// definition committed by hand); a rollback leaves the App's pages and its
// starts on different versions; and a later version undoes a rebind it
// never made.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

type Person = Awaited<ReturnType<typeof signedIn>>;

/** `person`'s chat of App `app`, its own (`chats.forApp`). */
const appChat = async (person: Person, app: string): Promise<ChatId> => {
  const chat = await person.api.chats.forApp(app);
  return chatIdSchema.parse(chat.id);
};

/**
 * A workflow of `owner`'s with three published versions: 1 waiting for
 * `jobEvents`; 2 for `laterEvents` too; 3 as 2, but for its label. Shared
 * with each of `builders` as a user.
 */
const threeVersions = async (
  admin: Person,
  owner: Person,
  builders: readonly Person[] = []
) => {
  const events = await jobEventsContract(admin);
  const api = owner.api.workflowResources;
  const flow = await api.create(`bound-${unique()}`);
  const versions = [
    jobWaitingOf(events),
    jobWaitingOf(events, { more: ["laterEvents"] }),
    jobWaitingOf(events, { more: ["laterEvents"], label: "Version 3" }),
  ];
  for (const [index, definition] of versions.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- each version on the last
    await api.publish(flow.id, {
      definition,
      basedOn: index === 0 ? null : index,
    });
  }
  for (const builder of builders) {
    // oxlint-disable-next-line no-await-in-loop -- one share at a time
    await api.share(flow.id, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
  }
  return flow.id;
};

/**
 * An App of `builder`'s whose current version 1 declares and binds
 * version 1 of `flow` under `review`, and its version 2, a draft binding
 * version 2 there, proposed but not current.
 */
const proposedRebind = async (builder: Person, flow: string) => {
  const { id: app } = await builder.api.apps.create({ name: "Requests" });
  await builder.api.workflowResources.bindToApp(flow, {
    app,
    alias: "review",
    version: 1,
  });
  const first = await release(
    builder,
    app,
    requestsApp("review", jobEventsDeclared)
  );
  const chatId = await appChat(builder, app);
  await builder.api.chats.defineDraft(chatId, app, {
    op: "bindWorkflow",
    alias: "review",
    workflow: flow,
    version: 2,
  });
  const second = await builder.api.chats.proposeDraft(
    chatId,
    app,
    "Bind version 2"
  );
  return { app, first, second };
};

/** What App `app` binds, by alias, as its builder `person` reads it. */
const boundOf = async (person: Person, app: string) => {
  const listed = await person.api.workflowResources.appBindings(app);
  return Object.fromEntries(
    listed.map(({ alias, workflowId, version }) => [
      alias,
      { workflowId, version },
    ])
  );
};

/** What version `version` of App `app`'s release seals of its workflows. */
const sealedOf = async (app: string, version: number) => {
  const sealed = await loadRelease(env, appIdSchema.parse(app), version);
  return Object.fromEntries(
    sealed.workflows.map(({ alias, pinned }) => [alias, pinned])
  );
};

/** Version `version` of App `app`, current and published no more. */
const unpublish = async (app: string, version: number): Promise<void> => {
  await env.DB.prepare(
    "UPDATE app_versions SET published_manifest_hash = NULL WHERE app_id = ? AND version = ?"
  )
    .bind(app, version)
    .run();
};

/** The batch that makes a version current. */
const switching = /update "apps" set "current_version"/iu;

describe(
  "a workflow binding recorded with an App version",
  { timeout: 180_000 },
  () => {
    it("binds nothing until its version is current, then binds it in the same switch, its release sealing the same version for its pages, audited with the App version", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, builder);
      const { app, second } = await proposedRebind(builder, flow);
      const proposed = await boundOf(builder, app);

      await builder.api.apps.versions.setCurrent(app, second);
      const events = await allEvents();
      const audited = events
        .filter(
          ({ action, target, detail }) =>
            action === "workflow.app_binding.bound" &&
            target?.id === app &&
            detail.appVersion !== undefined
        )
        .map(({ detail }) => ({
          alias: detail.alias,
          workflowId: detail.workflowId,
          version: detail.version,
          appVersion: detail.appVersion,
          replacedVersion: detail.replacedVersion,
        }));

      expect({
        proposed,
        current: await boundOf(builder, app),
        sealed: await sealedOf(app, second),
        audited,
      }).toStrictEqual({
        proposed: { review: { workflowId: flow, version: 1 } },
        current: { review: { workflowId: flow, version: 2 } },
        sealed: { review: { workflowId: flow, version: 2 } },
        audited: [
          {
            alias: "review",
            workflowId: flow,
            version: 2,
            appVersion: second,
            replacedVersion: 1,
          },
        ],
      });
    });

    it("binds again what each version's release sealed as it is rolled back and forward, so its pages and its starts name the same version", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, builder);
      const { app, first, second } = await proposedRebind(builder, flow);
      await builder.api.apps.versions.setCurrent(app, second);

      await builder.api.apps.versions.setCurrent(app, first);
      const rolledBack = await boundOf(builder, app);
      await builder.api.apps.versions.setCurrent(app, second);

      expect({
        rolledBack,
        sealedFirst: await sealedOf(app, first),
        forward: await boundOf(builder, app),
      }).toStrictEqual({
        rolledBack: { review: { workflowId: flow, version: 1 } },
        sealedFirst: { review: { workflowId: flow, version: 1 } },
        forward: { review: { workflowId: flow, version: 2 } },
      });
    });

    it("keeps a rebind of the same contract made since, when a later version only carries the binding its parent recorded", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, builder);
      const { app, second } = await proposedRebind(builder, flow);
      await builder.api.apps.versions.setCurrent(app, second);
      // The same contract as version 2: bound directly, as before.
      const rebound = await outcome(
        builder.api.workflowResources.bindToApp(flow, {
          app,
          alias: "review",
          version: 3,
        })
      );
      // A change to its page alone: the definition, and the binding it
      // recorded, carried over from version 2.
      const { version: third } = await builder.api.apps.files.commit(
        app,
        {
          "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Desk = () => <main>Open requests</main>;

export const Route = createFileRoute("/")({ component: Desk });
`,
        },
        "Rename the page"
      );
      await builder.api.apps.versions.setCurrent(app, third);

      expect({
        rebound,
        current: await boundOf(builder, app),
        sealed: await sealedOf(app, third),
      }).toStrictEqual({
        rebound: "ok",
        current: { review: { workflowId: flow, version: 3 } },
        sealed: { review: { workflowId: flow, version: 3 } },
      });
    });

    it("refuses the whole switch when whoever bound it lost their role in the workflow, or whoever makes the version current has none, leaving the current version and its binding", async () => {
      const [admin, owner, builder, otherBuilder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
        signedIn("builder"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, owner, [builder]);
      const { app, first, second } = await proposedRebind(builder, flow);
      // Builds the App, with no role in the workflow.
      await builder.api.apps.members.add(app, {
        type: "person",
        id: otherBuilder.userId,
        role: "builder",
      });
      const noRole = await outcome(
        otherBuilder.api.apps.versions.setCurrent(app, second)
      );
      await owner.api.workflowResources.unshare(flow, {
        type: "person",
        id: builder.userId,
      });
      // An admin has a role in every workflow; the person who bound it has
      // none any more.
      const binderLost = await outcome(
        admin.api.apps.versions.setCurrent(app, second)
      );
      const { currentVersion } = await admin.api.apps.get(app);

      expect({
        noRole,
        binderLost,
        currentVersion,
        bound: await boundOf(admin, app),
      }).toStrictEqual({
        noRole: "workflow.app_version_binding_unavailable",
        binderLost: "workflow.app_version_binding_unavailable",
        currentVersion: first,
        bound: { review: { workflowId: flow, version: 1 } },
      });
    });

    it("refuses the whole switch when the workflow is deleted, or the App version unpublished, as the switch lands", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, builder);
      const { app, first, second } = await proposedRebind(builder, flow);
      // Its release sealed and published first, then made current: the
      // version unpublished between the two.
      const unpublished = await outcome(
        publishVersion(
          {
            ...env,
            DB: racingDb(async () => {
              await unpublish(app, second);
            }, switching),
          },
          builder.acting,
          app,
          second
        )
      );
      const afterUnpublished = await boundOf(builder, app);
      // Published again, and the workflow it binds deleted as it lands.
      const deleted = await outcome(
        publishVersion(
          {
            ...env,
            DB: racingDb(async () => {
              const [held] =
                await builder.api.workflowResources.appBindings(app);
              await builder.api.workflowResources.unbindFromApp(held?.id ?? "");
              await builder.api.workflowResources.delete(flow);
            }, switching),
          },
          builder.acting,
          app,
          second
        )
      );
      const { currentVersion } = await builder.api.apps.get(app);

      expect({
        unpublished,
        afterUnpublished,
        deleted,
        currentVersion,
        afterDeleted: await boundOf(builder, app),
      }).toStrictEqual({
        unpublished: "version.unpublished",
        afterUnpublished: { review: { workflowId: flow, version: 1 } },
        deleted: "workflow.app_version_binding_unavailable",
        currentVersion: first,
        afterDeleted: {},
      });
    });

    it("refuses the whole switch for a version whose declaration isn't what the version it binds has, or that binds a workflow its author has no role in, whatever its definition says", async () => {
      const [admin, builder, stranger] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, builder);
      const strangers = await threeVersions(admin, stranger);
      const { app, first } = await proposedRebind(builder, flow);
      // Committed by hand: version 2 bound, version 1's contract declared.
      const { version: mismatched } = await commitApp(
        builder.api.apps.files,
        app,
        requestsApp("review", jobEventsDeclared, {
          workflowId: flow,
          version: 2,
        }),
        "Bind version 2, declaring version 1"
      );
      const contractChanged = await outcome(
        builder.api.apps.versions.setCurrent(app, mismatched)
      );
      // Committed by hand: a workflow its author can't see.
      const { version: foreign } = await commitApp(
        builder.api.apps.files,
        app,
        requestsApp("review", jobEventsDeclared, {
          workflowId: strangers,
          version: 1,
        }),
        "Bind someone else's workflow"
      );
      const unseen = await outcome(
        admin.api.apps.versions.setCurrent(app, foreign)
      );
      const { currentVersion } = await builder.api.apps.get(app);

      expect({
        contractChanged,
        unseen,
        currentVersion,
        bound: await boundOf(builder, app),
      }).toStrictEqual({
        contractChanged: "workflow.app_binding_contract_changed",
        unseen: "workflow.app_version_binding_unavailable",
        currentVersion: first,
        bound: { review: { workflowId: flow, version: 1 } },
      });
    });
  }
);
