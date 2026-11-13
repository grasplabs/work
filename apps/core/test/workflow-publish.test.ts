import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  draftCheckpointsOf,
  draftOf,
  restoreCheckpoint,
  saveDraft,
} from "../src/drafts.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { publish, rollback } from "../src/publish.ts";
import {
  createTriggerResource,
  setTriggerEnabled,
} from "../src/trigger-resources.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-editor.ts";
import {
  workflowKind,
  createWorkflowResource,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { greetingOf } from "./json-workflow-apps.ts";
import { person } from "./sealed-run-harness.ts";
import { outcome, unique } from "./sign-in.ts";

// Publishing a workflow's draft and rolling back to one of its versions
// (publish.ts, workflow-publish.ts), from their threat model: a draft
// written over a stale read never lands, each write is a checkpoint to
// restore; what goes live is the draft the builder read; every trigger,
// a disabled one too, starts the version that goes live, audited on it
// with the batch that makes it live; a run keeps the version it started on; and a batch whose answer was
// lost, tried again, is answered as the roll back it is. Each test makes
// its own people and workflows.

/** Writes `text` into workflow `id`'s draft over the revision it is at. */
const saved = async (by: Identity, id: string, text: string) => {
  const { revision } = await workflowDraft(env, by, id);
  return await editWorkflowDraft(env, by, id, { revision, source: text });
};

/** A workflow of `by`'s, its draft written `text` and published. */
const publishedWorkflow = async (by: Identity, text: string) => {
  const workflow = await createWorkflowResource(env, by, `flow-${unique()}`);
  await saved(by, workflow.id, text);
  const { revision } = await workflowDraft(env, by, workflow.id);
  await publish(env, workflowKind, by, workflow.id, revision);
  return workflow;
};

/** Publishes workflow `id`'s draft as it is now. */
const published = async (by: Identity, id: string) => {
  const { revision } = await workflowDraft(env, by, id);
  return await publish(env, workflowKind, by, id, revision);
};

/** The versions trigger `id` was audited starting from, oldest first. */
const followedBy = async (id: string): Promise<unknown[]> => {
  const events = await allEvents();
  return events.flatMap(({ action, target, detail }) =>
    action === "trigger.updated" && target?.id === id
      ? [detail.workflowVersion]
      : []
  );
};

/** A schedule trigger of workflow `id`, granted its start. */
const scheduled = async (admin: Identity, id: string): Promise<string> => {
  const trigger = await createTriggerResource(env, admin, {
    kind: "schedule",
    workflowId: id,
    config: {
      schedule: { cron: "0 0 1 1 *", timeZone: "UTC" },
      input: { who: "Ada" },
      missedOccurrences: "coalesce",
    },
  });
  const request: PermissionRequest = {
    subject: { type: "trigger", triggerId: triggerIdSchema.parse(trigger.id) },
    object: {
      type: "workflow",
      workflowId: workflowResourceIdSchema.parse(id),
    },
    actions: ["start"],
    binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
  };
  const asked = await requestPermission(env, admin, request, {
    app: () => {
      throw new Error("No App here");
    },
    resource: async (ref, needed) => {
      await requireResourceRole(env, admin, ref, needed);
    },
  });
  await grantPermission(env, admin, asked.id, { version: null });
  return trigger.id;
};

describe("a workflow's draft", () => {
  it("keeps each edit as a checkpoint, restores one as a new checkpoint, and refuses a write over a stale revision", async () => {
    const ada = await person("builder");
    const workflow = await createWorkflowResource(env, ada, `flow-${unique()}`);
    const first = greetingOf(undefined, "First");
    const second = greetingOf(undefined, "Second");
    await saved(ada, workflow.id, first);
    await saved(ada, workflow.id, second);
    const stale = await outcome(
      editWorkflowDraft(env, ada, workflow.id, { revision: 1, source: first })
    );
    const subject = { kind: "workflow", id: workflow.id } as const;
    const before = await draftCheckpointsOf(env, subject);
    const oldest = before.at(-1);
    if (oldest === undefined) {
      throw new Error("No checkpoint kept");
    }
    const restored = await restoreCheckpoint(
      env,
      workflowKind,
      workflow.id,
      ada,
      oldest.number,
      2
    );
    const now = await workflowDraft(env, ada, workflow.id);
    const staleRestore = await outcome(
      restoreCheckpoint(env, workflowKind, workflow.id, ada, 1, 2)
    );

    expect({
      stale,
      kept: before.map(({ number, touched, personId }) => ({
        number,
        touched,
        personId,
      })),
      restored: {
        number: restored.number,
        restoredFrom: restored.restoredFrom,
      },
      now: { revision: now.revision, source: now.source },
      staleRestore,
    }).toStrictEqual({
      stale: "draft.conflict",
      kept: [
        { number: 2, touched: ["workflow.json"], personId: ada.userId },
        { number: 1, touched: ["workflow.json"], personId: ada.userId },
      ],
      restored: { number: 3, restoredFrom: 1 },
      now: { revision: 3, source: first },
      staleRestore: "draft.conflict",
    });
  });
});

describe("publishing a workflow", { timeout: 60_000 }, () => {
  it("has its triggers start the version it makes live, a disabled one too, leaves a running run where it was, and labels the version", async () => {
    const admin = await person("admin");
    const workflow = await publishedWorkflow(
      admin,
      greetingOf("1 hour", "Version 1")
    );
    const [enabled, disabled] = await Promise.all([
      scheduled(admin, workflow.id),
      scheduled(admin, workflow.id),
    ]);
    await setTriggerEnabled(env, admin, disabled, false);
    const run = await startWorkflow(
      env,
      { type: "person", person: admin },
      workflow.id,
      { version: 1, args: { who: "Ada" }, key: `key-${unique()}` }
    );
    await saved(admin, workflow.id, greetingOf("1 hour", "Version 2"));
    const live = await published(admin, workflow.id);
    const running = await resourceRunFor(env, admin, workflow.id, run.id);
    const versions = await workflowVersions(env, admin, workflow.id);
    const draft = await workflowDraft(env, admin, workflow.id);
    const events = await allEvents();

    expect({
      live: {
        version: live.version,
        label: /^\d\d\.\d\d\.\d+$/u.test(live.label),
      },
      triggers: [await followedBy(enabled), await followedBy(disabled)],
      run: { version: running.version, ended: running.endedAt !== null },
      labelled: versions.map(({ version, label }) => ({
        version,
        labelled: label !== null,
      })),
      // The draft is over the version live, changing nothing.
      draft: draft.source,
      audited: events
        .filter(
          ({ action, target }) =>
            action === "version.published" && target?.id === workflow.id
        )
        .map(({ detail }) => detail.version),
    }).toStrictEqual({
      live: { version: 2, label: true },
      triggers: [[2], [2]],
      run: { version: 1, ended: false },
      labelled: [
        { version: 2, labelled: true },
        { version: 1, labelled: true },
      ],
      draft: greetingOf("1 hour", "Version 2"),
      audited: [1, 2],
    });
  });

  it("empties a draft left over an older version that holds nothing the live one hasn't, answering the live version", async () => {
    const ada = await person("builder");
    const workflow = await publishedWorkflow(ada, greetingOf(undefined, "v1"));
    await saved(ada, workflow.id, greetingOf(undefined, "v2"));
    const live = await published(ada, workflow.id);
    // Left over version 1 with what version 2 has, as a write that landed
    // while version 2 went live, and stayed so, leaves it.
    const stale = await saveDraft(
      env,
      workflowKind,
      workflow.id,
      await draftOf(env, workflowKind, workflow.id),
      { changes: { "workflow.json": greetingOf(undefined, "v2") } },
      { by: ada, detail: {} }
    );
    await env.DB.prepare(
      "UPDATE drafts SET base = 1 WHERE subject_kind = 'workflow' AND subject_id = ?"
    )
      .bind(workflow.id)
      .run();

    const again = await publish(
      env,
      workflowKind,
      ada,
      workflow.id,
      stale.revision
    );
    const after = await draftOf(env, workflowKind, workflow.id);
    const versions = await workflowVersions(env, ada, workflow.id);

    expect({
      again: again.version,
      changes: after.changes,
      base: after.base,
      versions: versions.length,
    }).toStrictEqual({
      again: live.version,
      changes: {},
      base: live.version,
      versions: 2,
    });
  });

  it("rolls back to an earlier version, its label kept, its triggers starting it and its draft moved onto it", async () => {
    const admin = await person("admin");
    const workflow = await publishedWorkflow(
      admin,
      greetingOf(undefined, "Version 1")
    );
    const trigger = await scheduled(admin, workflow.id);
    const [first] = await workflowVersions(env, admin, workflow.id);
    await saved(admin, workflow.id, greetingOf(undefined, "Version 2"));
    await published(admin, workflow.id);
    // Unpublished work, discarded by the roll back the builder confirms.
    await saved(admin, workflow.id, greetingOf(undefined, "Unpublished"));
    const { revision } = await workflowDraft(env, admin, workflow.id);
    const unseen = await outcome(
      rollback(env, workflowKind, admin, workflow.id, 1, revision - 1)
    );
    const back = await rollback(
      env,
      workflowKind,
      admin,
      workflow.id,
      1,
      revision
    );
    const draft = await workflowDraft(env, admin, workflow.id);

    expect({
      unseen,
      back: { version: back.version, label: back.label },
      trigger: await followedBy(trigger),
      draft: draft.source,
    }).toStrictEqual({
      unseen: "draft.conflict",
      back: { version: 1, label: first?.label },
      trigger: [2, 1],
      draft: greetingOf(undefined, "Version 1"),
    });
  });

  it("answers a roll back whose batch landed but whose answer was lost as made, when the batch is tried again", async () => {
    const admin = await person("admin");
    const workflow = await publishedWorkflow(
      admin,
      greetingOf(undefined, "Version 1")
    );
    const trigger = await scheduled(admin, workflow.id);
    await saved(admin, workflow.id, greetingOf(undefined, "Version 2"));
    await published(admin, workflow.id);
    await saved(admin, workflow.id, greetingOf(undefined, "Unpublished"));
    const { revision } = await workflowDraft(env, admin, workflow.id);
    // D1 commits the batch that makes the version live, and the answer is
    // lost on its way back: the batch is tried again (`retriedBatch`).
    // That batch is the only one of the roll back's with more than a few
    // statements; a read is two at most.
    let lost = false;
    const lossy: Env = {
      ...env,
      DB: new Proxy(env.DB, {
        get: (target, name): unknown => {
          if (name !== "batch") {
            return Reflect.get(target, name);
          }
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!lost && statements.length > 4) {
              lost = true;
              throw new Error("Network connection lost.");
            }
            return result;
          };
        },
      }),
    };
    const back = await outcome(
      rollback(lossy, workflowKind, admin, workflow.id, 1, revision)
    );
    const draft = await workflowDraft(env, admin, workflow.id);
    const events = await allEvents();
    const discarded = events.filter(
      ({ action, target }) =>
        action === "draft.discarded" && target?.id === workflow.id
    );

    expect({
      lost,
      back,
      // Each audited once, though the roll back's batch ran twice.
      trigger: await followedBy(trigger),
      draft: draft.source,
      discarded: discarded.length,
    }).toStrictEqual({
      lost: true,
      back: "ok",
      trigger: [2, 1],
      draft: greetingOf(undefined, "Version 1"),
      discarded: 1,
    });
  });
});
