import { actorOf } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { draftOf, emptyDraft } from "../src/app-drafts.ts";
import { publishVersion } from "../src/app-publish.ts";
import { loadRelease } from "../src/app-releases.ts";
import {
  commitDraft,
  draftDefinition,
  draftFiles,
  nextVersion,
} from "../src/apps.ts";
import { appOf, commitApp } from "./app-definitions.ts";
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
// fail: the person who bound it loses their role in the workflow before
// it is first current, or whoever makes the version current, first or
// again, has none; a rollback is held to an author who left since; the
// workflow is deleted, or
// the App version unpublished, between the check and the switch; the
// version's declaration and the version it binds no longer agree (a
// definition committed by hand); a rollback leaves the App's pages and its
// starts on different versions; and a later version undoes a rebind it
// never made.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

type Person = Awaited<ReturnType<typeof signedIn>>;

/**
 * Commits App `app`'s draft as its next version, as its builder
 * `person` publishes it but without making it current: a version that
 * binds what the draft binds, for a test to make current, or not. The
 * draft is emptied over it after, as a publish leaves it.
 */
const committedDraft = async (
  person: Person,
  app: string,
  message: string
): Promise<number> => {
  const id = appIdSchema.parse(app);
  const draft = await draftOf(env, id);
  const defined = await draftDefinition(env, id, draft);
  const { version } = await commitDraft(
    env,
    person.acting,
    id,
    {
      parent: draft.base,
      version: await nextVersion(env, id),
      files: await draftFiles(env, id, draft),
      definition: defined?.definition ?? null,
    },
    message
  );
  await emptyDraft(env, id, {
    revision: draft.revision,
    base: version,
    by: { ...person.acting, actor: actorOf(person.acting) },
    published: true,
  });
  return version;
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
 * version 2 there, committed but not current.
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
  await builder.api.apps.drafts.define(app, {
    op: "bindWorkflow",
    alias: "review",
    workflow: flow,
    version: 2,
  });
  const second = await committedDraft(builder, app, "Bind version 2");
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

      await builder.api.apps.versions.publish(app, second);
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
          recordedBy: detail.recordedBy,
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
            recordedBy: builder.userId,
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
      await builder.api.apps.versions.publish(app, second);

      await builder.api.apps.versions.publish(app, first);
      const rolledBack = await boundOf(builder, app);
      await builder.api.apps.versions.publish(app, second);

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

    it("refuses a rollback to a version that sealed no binding for an alias it declares, while the App binds a version of another contract there", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, builder);
      const { id: app } = await builder.api.apps.create({ name: "Requests" });
      // Released before anything is bound: its release seals no binding.
      const first = await release(
        builder,
        app,
        requestsApp("review", jobEventsDeclared)
      );
      await builder.api.workflowResources.bindToApp(flow, {
        app,
        alias: "review",
        version: 1,
      });
      await builder.api.apps.drafts.define(app, {
        op: "bindWorkflow",
        alias: "review",
        workflow: flow,
        version: 2,
      });
      const second = await committedDraft(builder, app, "Bind version 2");
      await builder.api.apps.versions.publish(app, second);

      const rolledBack = await outcome(
        builder.api.apps.versions.publish(app, first)
      );
      const { currentVersion } = await builder.api.apps.get(app);

      expect({
        sealedFirst: await sealedOf(app, first),
        rolledBack,
        currentVersion,
        bound: await boundOf(builder, app),
      }).toStrictEqual({
        sealedFirst: {},
        rolledBack: "workflow.app_binding_contract_changed",
        currentVersion: second,
        bound: { review: { workflowId: flow, version: 2 } },
      });
    });

    it("keeps a rebind of the same contract made since, when a later version only carries the binding its parent recorded, and tells a draft binding that recorded version again to bind it directly", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, builder);
      const { app, second } = await proposedRebind(builder, flow);
      await builder.api.apps.versions.publish(app, second);
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
      await builder.api.apps.versions.publish(app, third);
      // Version 2 again, from a draft: what the current version records
      // already, so it would bind nothing.
      const again = await builder.api.apps.drafts.define(app, {
        op: "bindWorkflow",
        alias: "review",
        workflow: flow,
        version: 2,
      });

      expect({
        rebound,
        current: await boundOf(builder, app),
        sealed: await sealedOf(app, third),
        again,
      }).toStrictEqual({
        rebound: "ok",
        current: { review: { workflowId: flow, version: 3 } },
        sealed: { review: { workflowId: flow, version: 3 } },
        again: {
          ok: false,
          problem:
            "The App's current version binds version 2 as `review` already, and `review` was bound to another version, or unbound, directly since. Bind version 2 directly, as `env.workflowBuild.bind` does: its contract is the one the App declares.",
        },
      });
    });

    it("rolls back to a version whose release sealed a workflow deleted since, leaving its alias unbound", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, builder);
      const { id: app } = await builder.api.apps.create({ name: "Requests" });
      await builder.api.workflowResources.bindToApp(flow, {
        app,
        alias: "review",
        version: 1,
      });
      const declaring = requestsApp("review", jobEventsDeclared);
      const first = await release(builder, app, declaring);
      await release(
        builder,
        app,
        appOf(declaring.definition, {
          ...declaring.files,
          "src/routes/index.tsx": (
            declaring.files["src/routes/index.tsx"] ?? ""
          ).replace("Requests", "Open requests"),
        })
      );
      const [held] = await builder.api.workflowResources.appBindings(app);
      await builder.api.workflowResources.unbindFromApp(held?.id ?? "");
      await builder.api.workflowResources.delete(flow);

      const rolledBack = await outcome(
        builder.api.apps.versions.publish(app, first)
      );

      expect({
        sealedFirst: await sealedOf(app, first),
        rolledBack,
        bound: await boundOf(builder, app),
      }).toStrictEqual({
        sealedFirst: { review: { workflowId: flow, version: 1 } },
        rolledBack: "ok",
        bound: {},
      });
    });

    it("binds a version of the same contract a draft bound, carried into a later version before either was current, as its release seals it, holding that later version's author to none of it", async () => {
      const [admin, builder, pagesOnly] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, builder);
      const { app, second } = await proposedRebind(builder, flow);
      await builder.api.apps.versions.publish(app, second);
      // Version 3 of the workflow, of version 2's contract, bound from a
      // draft proposed but never made current.
      await builder.api.apps.drafts.define(app, {
        op: "bindWorkflow",
        alias: "review",
        workflow: flow,
        version: 3,
      });
      await committedDraft(builder, app, "Bind version 3");
      // A page change over it, carrying that binding, by a builder of the
      // App with no role in the workflow.
      await builder.api.apps.members.add(app, {
        type: "person",
        id: pagesOnly.userId,
        role: "builder",
      });
      const { version: later } = await pagesOnly.api.apps.files.commit(
        app,
        {
          "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Desk = () => <main>Open requests</main>;

export const Route = createFileRoute("/")({ component: Desk });
`,
        },
        "Rename the page"
      );
      await builder.api.apps.versions.publish(app, later);

      expect({
        bound: await boundOf(builder, app),
        sealed: await sealedOf(app, later),
      }).toStrictEqual({
        bound: { review: { workflowId: flow, version: 3 } },
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
        otherBuilder.api.apps.versions.publish(app, second)
      );
      await owner.api.workflowResources.unshare(flow, {
        type: "person",
        id: builder.userId,
      });
      // An admin has a role in every workflow; the person who bound it has
      // none any more.
      const binderLost = await outcome(
        admin.api.apps.versions.publish(app, second)
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

    it("makes a version current again on the authority of whoever does it, after its binding's author lost their role, while no one without a role in the workflow does", async () => {
      const [admin, owner, builder, otherBuilder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
        signedIn("builder"),
        signedIn("builder"),
      ]);
      const flow = await threeVersions(admin, owner, [builder]);
      const { app, first, second } = await proposedRebind(builder, flow);
      await builder.api.apps.versions.publish(app, second);
      await builder.api.apps.versions.publish(app, first);
      await builder.api.apps.members.add(app, {
        type: "person",
        id: otherBuilder.userId,
        role: "builder",
      });
      await owner.api.workflowResources.unshare(flow, {
        type: "person",
        id: builder.userId,
      });

      // Neither the author, who lost their role, nor a builder of the App
      // who never had one binds the workflow by making it current again.
      const author = await outcome(
        builder.api.apps.versions.publish(app, second)
      );
      const noRole = await outcome(
        otherBuilder.api.apps.versions.publish(app, second)
      );
      const refused = await boundOf(admin, app);
      // An admin has a role in every workflow.
      const withRole = await outcome(
        admin.api.apps.versions.publish(app, second)
      );
      const { currentVersion } = await admin.api.apps.get(app);

      expect({
        author,
        noRole,
        refused,
        withRole,
        currentVersion,
        bound: await boundOf(admin, app),
      }).toStrictEqual({
        author: "workflow.app_version_binding_unavailable",
        noRole: "workflow.app_version_binding_unavailable",
        refused: { review: { workflowId: flow, version: 1 } },
        withRole: "ok",
        currentVersion: second,
        bound: { review: { workflowId: flow, version: 2 } },
      });
    });

    it("refuses the whole switch when the workflow is deleted, the alias unbound, or the App version unpublished, as the switch lands", async () => {
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
      // Published again, and the alias unbound as it lands: not the
      // binding it was checked against any more.
      const unbound = await outcome(
        publishVersion(
          {
            ...env,
            DB: racingDb(async () => {
              const [held] =
                await builder.api.workflowResources.appBindings(app);
              await builder.api.workflowResources.unbindFromApp(held?.id ?? "");
            }, switching),
          },
          builder.acting,
          app,
          second
        )
      );
      // Published again, and the workflow it binds deleted as it lands.
      const deleted = await outcome(
        publishVersion(
          {
            ...env,
            DB: racingDb(async () => {
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
        unbound,
        deleted,
        currentVersion,
        afterDeleted: await boundOf(builder, app),
      }).toStrictEqual({
        unpublished: "version.unpublished",
        afterUnpublished: { review: { workflowId: flow, version: 1 } },
        unbound: "app.conflict",
        deleted: "workflow.app_version_binding_unavailable",
        currentVersion: first,
        afterDeleted: {},
      });
    });

    it("refuses the whole switch for a version whose declaration isn't what the version it binds has, and a commit recording a workflow its author has no role in, whatever its definition says", async () => {
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
        builder.api.apps.versions.publish(app, mismatched)
      );
      // Committed by hand: a workflow its author can't see, refused as it
      // is committed, so no later version of anyone's carries it.
      const unseen = await outcome(
        commitApp(
          builder.api.apps.files,
          app,
          requestsApp("review", jobEventsDeclared, {
            workflowId: strangers,
            version: 1,
          }),
          "Bind someone else's workflow"
        )
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
