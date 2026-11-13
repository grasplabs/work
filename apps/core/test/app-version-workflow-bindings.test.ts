import { actorOf } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { loadRelease } from "../src/app-releases.ts";
import {
  appKind,
  commitDraft,
  draftDefinition,
  nextVersion,
} from "../src/apps.ts";
import { draftOf, emptyDraft, filesOf } from "../src/drafts.ts";
import { rollback } from "../src/publish.ts";
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
import { publishOverRpc } from "./workflow-publishing.ts";

// A workflow bound from an App's draft (`bindWorkflow`) is recorded with
// the App version the draft becomes, and bound as that version is made
// current, in the same switch, never before (app-workflow-bindings.ts);
// like any binding, its starts run the workflow's live version. These
// tests start from the ways that can fail: the person who bound it loses
// their role in the workflow before it is first current; the alias is
// rebound between the check and the switch; the version's declaration
// and the workflow's live version no longer agree; and a rollback leaves
// the App's pages and its starts on different workflows.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

type Person = Awaited<ReturnType<typeof signedIn>>;

/**
 * Commits App `app`'s draft as its next version, as its builder
 * `person` publishes it but without making it current: a version that
 * binds what the draft binds, for a test to make current, or not. The
 * draft is emptied over it after, as a publish leaves it.
 */
const committedDraft = async (person: Person, app: string): Promise<number> => {
  const id = appIdSchema.parse(app);
  const draft = await draftOf(env, appKind, id);
  const defined = await draftDefinition(env, id, draft);
  const { version } = await commitDraft(env, person.acting, id, {
    parent: draft.base,
    version: await nextVersion(env, id),
    files: await filesOf(env, appKind, id, draft),
    definition: defined?.definition ?? null,
  });
  await emptyDraft(env, appKind, id, {
    revision: draft.revision,
    base: version,
    by: { ...person.acting, actor: actorOf(person.acting) },
    live: true,
  });
  return version;
};

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
 * An App of `builder`'s whose current version 1 declares and binds
 * workflow `first` under `review`, and its version 2, a draft of `by`'s
 * binding workflow `then` there, committed but not current.
 */
const proposedRebind = async (
  builder: Person,
  first: string,
  then: string,
  by: Person = builder
) => {
  const { id: app } = await builder.api.apps.create({ name: "Requests" });
  await builder.api.workflowResources.bindToApp(first, {
    app,
    alias: "review",
  });
  const current = await release(
    builder,
    app,
    requestsApp("review", jobEventsDeclared)
  );
  await by.api.apps.define(app, {
    op: "bindWorkflow",
    alias: "review",
    workflow: then,
  });
  const proposed = await committedDraft(by, app);
  return { app, current, proposed };
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
    sealed.workflows.map(({ alias, pinned }) => [alias, pinned.workflowId])
  );
};

/** The batch that makes a version current. */
const switching = /update "apps" set "current_version"/iu;

describe(
  "a workflow binding recorded with an App version",
  { timeout: 180_000 },
  () => {
    it("binds nothing until its version is current, then binds it in the same switch, its release sealing the same workflow for its pages, audited with the App version, and keeps it over a roll back to a version that only carried its binding", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const events = await jobEventsContract(admin);
      const first = await declaredWorkflow(builder, events);
      const then = await declaredWorkflow(builder, events);
      const { app, current, proposed } = await proposedRebind(
        builder,
        first,
        then
      );
      const before = await boundOf(builder, app);

      await builder.api.versions.rollback({ kind: "app", id: app }, proposed);
      const after = await boundOf(builder, app);
      const recorded = await allEvents();
      const audited = recorded
        .filter(
          ({ action, target, detail }) =>
            action === "workflow.app_binding.bound" &&
            target?.id === app &&
            detail.appVersion !== undefined
        )
        .map(({ detail }) => ({
          workflowId: detail.workflowId,
          appVersion: detail.appVersion,
          recordedBy: detail.recordedBy,
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
        audited: [
          {
            workflowId: then,
            appVersion: proposed,
            recordedBy: builder.userId,
            replacedWorkflowId: first,
          },
        ],
        // Version 1 recorded no binding of its own: one of the same
        // contract made since stays.
        rolledBack: { review: then },
      });
    });

    it("refuses the whole switch when the alias is rebound as it lands, leaving the current version and its binding", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const events = await jobEventsContract(admin);
      const first = await declaredWorkflow(builder, events);
      const then = await declaredWorkflow(builder, events);
      const other = await declaredWorkflow(builder, events);
      const { app, current, proposed } = await proposedRebind(
        builder,
        first,
        then
      );
      const racing = racingDb(async () => {
        await builder.api.workflowResources.bindToApp(other, {
          app,
          alias: "review",
        });
      }, switching);

      const refused = await outcome(
        rollback({ ...env, DB: racing }, appKind, builder.acting, app, proposed)
      );
      const { currentVersion } = await builder.api.apps.get(app);

      expect({
        refused,
        currentVersion,
        bound: await boundOf(builder, app),
      }).toStrictEqual({
        refused: "draft.conflict",
        currentVersion: current,
        bound: { review: other },
      });
    });

    it("refuses the whole switch when whoever bound it lost their role in the workflow before it is first current", async () => {
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
      await owner.api.workflowResources.bindToApp(first, {
        app,
        alias: "review",
      });
      const current = await release(
        owner,
        app,
        requestsApp("review", jobEventsDeclared)
      );
      await author.api.apps.define(app, {
        op: "bindWorkflow",
        alias: "review",
        workflow: then,
      });
      const proposed = await committedDraft(author, app);
      await owner.api.workflowResources.members.remove(then, {
        type: "person",
        id: author.userId,
      });

      const refused = await outcome(
        owner.api.versions.rollback({ kind: "app", id: app }, proposed)
      );
      const { currentVersion } = await owner.api.apps.get(app);

      expect({
        refused,
        currentVersion,
        bound: await boundOf(owner, app),
      }).toStrictEqual({
        refused: "workflow.app_version_binding_unavailable",
        currentVersion: current,
        bound: { review: first },
      });
    });

    it("refuses the whole switch for a version whose declaration isn't what the workflow it binds has live now", async () => {
      const [admin, builder] = await Promise.all([
        signedIn("admin"),
        signedIn("builder"),
      ]);
      const events = await jobEventsContract(admin);
      const first = await declaredWorkflow(builder, events);
      const then = await declaredWorkflow(builder, events);
      const { app, current, proposed } = await proposedRebind(
        builder,
        first,
        then
      );
      // Bound by no App yet, the workflow goes live with another event.
      await publishOverRpc(
        builder.api,
        then,
        jobWaitingOf(events, { more: ["laterEvents"] })
      );

      const refused = await outcome(
        builder.api.versions.rollback({ kind: "app", id: app }, proposed)
      );
      const { currentVersion } = await builder.api.apps.get(app);

      expect({
        refused,
        currentVersion,
        bound: await boundOf(builder, app),
      }).toStrictEqual({
        refused: "workflow.app_binding_contract_changed",
        currentVersion: current,
        bound: { review: first },
      });
    });
  }
);
