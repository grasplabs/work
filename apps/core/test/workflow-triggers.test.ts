import type { Permission } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import {
  triggerEventsRequest,
  triggerStartRequest,
} from "@grasp-os/shared/workflow-triggers";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  deliverConnectorEvent,
  listenersOf,
} from "../src/workflows/connector-events.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { objectSchema } from "./json-workflow-apps.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// An independent workflow's triggers over the session's `/rpc`
// (`workflowResources.triggers`), from trigger-resources.ts's threat model:
// a trigger starts runs on its own, acting for its creator, so only a
// builder of the workflow creates one; nobody but who manages it sees,
// disables or deletes it; and only its owner, still a builder, moves it
// to another version or enables it again. Each test makes its own people
// and workflows.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/**
 * Version `version` of a workflow taking and handing back a `report`: a
 * step that never runs carries `version` as its title, so each version's
 * document differs.
 */
const definitionOf = (version: string): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectSchema({ report: { type: "string" } }),
    output: {
      schema: objectSchema({ report: { type: "string" } }),
      value: { report: { $expr: "input.report" } },
    },
    steps: [
      {
        id: "mark",
        title: `Version ${version}`,
        type: "raise",
        if: { $expr: "false" },
        error: { type: "urn:grasp:error:never", status: 422 },
      },
    ],
  });

/** A workflow `builder` owns, with two published versions. */
const reporting = async (builder: Person): Promise<string> => {
  const { id } = await builder.api.workflowResources.create(
    `report-${unique()}`
  );
  await builder.api.workflowResources.publish(id, {
    definition: definitionOf("1"),
    basedOn: null,
  });
  await builder.api.workflowResources.publish(id, {
    definition: definitionOf("1.1"),
    basedOn: 1,
  });
  return id;
};

const nightly = {
  schedule: { cron: "0 2 * * *", timeZone: "Europe/Amsterdam" },
  input: { report: "nightly" },
  missedOccurrences: "coalesce",
};

/** A nightly schedule trigger of `owner`'s on version 1 of `workflowId`. */
const nightlyTrigger = async (owner: Person, workflowId: string) =>
  await owner.api.workflowResources.triggers.create({
    kind: "schedule",
    workflowId,
    version: 1,
    config: nightly,
  });

/** A builder owning a workflow with a nightly trigger of theirs on it. */
const ownerWithTrigger = async () => {
  const owner = await personApi("builder");
  const workflow = await reporting(owner);
  const trigger = await nightlyTrigger(owner, workflow);
  return { owner, workflow, trigger };
};

/** The actions the log holds about trigger `id`, oldest first, with who took them. */
const loggedAbout = async (id: string) => {
  const logged = await allEvents();
  return logged
    .filter(({ target }) => target?.type === "trigger" && target.id === id)
    .map(({ action, actor }) => ({
      action,
      actor: actor.type === "person" ? actor.userId : actor.type,
    }));
};

/** The trigger holding a permission, if a trigger does. */
const triggerOf = ({ subject }: Pick<Permission, "subject">): string =>
  subject.type === "trigger" ? subject.triggerId : "";

describe("an independent workflow's triggers over /rpc", () => {
  it("are created by a builder of the workflow, acting for them, shown with their configuration, and audited", async () => {
    const { owner, workflow, trigger } = await ownerWithTrigger();

    const listed = await owner.api.workflowResources.triggers.list(workflow);

    expect({
      trigger: { ...trigger, createdAt: "", nextAt: "" },
      nextAtIsAhead: Date.parse(trigger.nextAt ?? "") > Date.now(),
      listed,
      logged: await loggedAbout(trigger.id),
    }).toStrictEqual({
      trigger: {
        id: trigger.id,
        kind: "schedule",
        owner: owner.userId,
        version: 1,
        workflowId: workflow,
        workflowVersion: 1,
        principal: owner.userId,
        enabled: true,
        createdAt: "",
        config: nightly,
        nextAt: "",
        address: null,
        webhook: null,
        stopped: false,
        // It asks an admin for its start as it is created.
        start: "requested",
        // It hears no connection.
        events: null,
      },
      nextAtIsAhead: true,
      listed: [trigger],
      logged: [{ action: "trigger.created", actor: owner.userId }],
    });
  });

  it("can't be created by anyone who doesn't build the workflow", async () => {
    const owner = await personApi("builder");
    const workflow = await reporting(owner);
    const [member, outsider, user] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("user"),
    ]);
    await owner.api.workflowResources.share(workflow, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    await owner.api.workflowResources.share(workflow, {
      type: "person",
      id: user.userId,
      role: "user",
    });

    const refused = await Promise.all(
      [member, outsider, user].map(
        async (person) => await outcome(nightlyTrigger(person, workflow))
      )
    );

    expect({
      refused,
      listed: await owner.api.workflowResources.triggers.list(workflow),
    }).toStrictEqual({
      refused: [
        "role.forbidden",
        "workflow.resource_unavailable",
        "role.forbidden",
      ],
      listed: [],
    });
  });

  it("are hidden from, and can't be disabled, moved or deleted by, anyone who doesn't manage them", async () => {
    const { owner, workflow, trigger } = await ownerWithTrigger();
    const [member, outsider] = await Promise.all([
      personApi("user"),
      personApi("builder"),
    ]);
    await owner.api.workflowResources.share(workflow, {
      type: "person",
      id: member.userId,
      role: "user",
    });

    const tries = await Promise.all(
      [member, outsider].map(async ({ api }) => ({
        listed: await api.workflowResources.triggers.list(workflow),
        disable: await outcome(
          api.workflowResources.triggers.setEnabled(trigger.id, false)
        ),
        move: await outcome(
          api.workflowResources.triggers.setVersion(trigger.id, 2)
        ),
        delete: await outcome(
          api.workflowResources.triggers.delete(trigger.id)
        ),
      }))
    );

    const refused = {
      listed: [],
      disable: "workflow.trigger_unavailable",
      move: "workflow.trigger_unavailable",
      delete: "workflow.trigger_unavailable",
    };
    expect({
      tries,
      listed: await owner.api.workflowResources.triggers.list(workflow),
    }).toStrictEqual({ tries: [refused, refused], listed: [trigger] });
  });

  it("are disabled and deleted by the workflow's other builders and admins, but enabled again only by their owner", async () => {
    const { owner, workflow, trigger } = await ownerWithTrigger();
    const [coBuilder, admin] = await Promise.all([
      personApi("builder"),
      personApi("admin"),
    ]);
    await owner.api.workflowResources.share(workflow, {
      type: "person",
      id: coBuilder.userId,
      role: "builder",
    });
    const { triggers } = coBuilder.api.workflowResources;

    const seen = await triggers.list(workflow);
    const disabled = await triggers.setEnabled(trigger.id, false);
    const reEnable = await outcome(triggers.setEnabled(trigger.id, true));
    const move = await outcome(triggers.setVersion(trigger.id, 2));
    const enabled = await owner.api.workflowResources.triggers.setEnabled(
      trigger.id,
      true
    );
    const seenByAdmin =
      await admin.api.workflowResources.triggers.list(workflow);
    // The `start` it asked for as it was created, as the admin's pending
    // list shows it: there until the trigger is deleted.
    const asked = async () => {
      const { items } = await admin.api.waiting.list();
      return items.filter(
        (item) =>
          item.kind === "permissionRequest" &&
          item.request.subject.type === "trigger" &&
          item.request.subject.triggerId === trigger.id
      ).length;
    };
    const askedBefore = await asked();
    await admin.api.workflowResources.triggers.delete(trigger.id);

    expect({
      seen,
      disabled: disabled.enabled,
      reEnable,
      move,
      enabled: enabled.enabled,
      seenByAdmin,
      afterDelete: await owner.api.workflowResources.triggers.list(workflow),
      asked: { before: askedBefore, afterDelete: await asked() },
      deleteAgain: await outcome(
        owner.api.workflowResources.triggers.delete(trigger.id)
      ),
      logged: await loggedAbout(trigger.id),
    }).toStrictEqual({
      seen: [trigger],
      disabled: false,
      reEnable: "workflow.trigger_unavailable",
      move: "workflow.trigger_unavailable",
      enabled: true,
      seenByAdmin: [{ ...trigger, nextAt: enabled.nextAt }],
      afterDelete: [],
      asked: { before: 1, afterDelete: 0 },
      deleteAgain: "workflow.trigger_unavailable",
      logged: [
        { action: "trigger.created", actor: owner.userId },
        { action: "trigger.disabled", actor: coBuilder.userId },
        { action: "trigger.enabled", actor: owner.userId },
        { action: "trigger.deleted", actor: admin.userId },
      ],
    });
  });

  it("move to another published version of their workflow for their owner, keeping their configuration", async () => {
    const { owner, workflow, trigger } = await ownerWithTrigger();
    const { triggers } = owner.api.workflowResources;

    const moved = await triggers.setVersion(trigger.id, 2);
    const unpublished = await outcome(triggers.setVersion(trigger.id, 3));

    expect({
      moved: { ...moved, nextAt: "" },
      unpublished,
      listed: await triggers.list(workflow),
    }).toStrictEqual({
      moved: { ...trigger, version: 2, workflowVersion: 2, nextAt: "" },
      unpublished: "workflow.version_not_found",
      listed: [moved],
    });
  });

  it("refuse a configuration their kind doesn't take, and an enabled state that isn't true or false", async () => {
    const { owner, workflow, trigger } = await ownerWithTrigger();
    const { triggers } = owner.api.workflowResources;

    const refused = {
      unknownKind: await outcome(
        triggers.create({ kind: "email", workflowId: workflow, version: 1 })
      ),
      noSchedule: await outcome(
        triggers.create({
          kind: "schedule",
          workflowId: workflow,
          version: 1,
          config: { ...nightly, schedule: { cron: "never", timeZone: "UTC" } },
        })
      ),
      wrongInput: await outcome(
        triggers.create({
          kind: "schedule",
          workflowId: workflow,
          version: 1,
          config: { ...nightly, input: { job: "nightly" } },
        })
      ),
      notABoolean: await outcome(
        // SAFETY: not a boolean, as a client could send it.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        triggers.setEnabled(trigger.id, "false" as never)
      ),
    };

    expect({ refused, listed: await triggers.list(workflow) }).toStrictEqual({
      refused: {
        unknownKind: "workflow.resource_invalid",
        noSchedule: "workflow.resource_invalid",
        wrongInput: "workflow.resource_invalid",
        notABoolean: "workflow.resource_invalid",
      },
      listed: [trigger],
    });
  });

  it("stay listed, and can be disabled and deleted, but not enabled or moved, by an owner who no longer builds the workflow", async () => {
    const owner = await personApi("builder");
    const workflow = await reporting(owner);
    const coBuilder = await personApi("builder");
    await owner.api.workflowResources.share(workflow, {
      type: "person",
      id: coBuilder.userId,
      role: "builder",
    });
    const ownersTrigger = await nightlyTrigger(owner, workflow);
    const theirs = await nightlyTrigger(coBuilder, workflow);
    await owner.api.workflowResources.unshare(workflow, {
      type: "person",
      id: coBuilder.userId,
    });
    const { triggers } = coBuilder.api.workflowResources;

    const listed = await triggers.list(workflow);
    const move = await outcome(triggers.setVersion(theirs.id, 2));
    const disabled = await triggers.setEnabled(theirs.id, false);
    const enable = await outcome(triggers.setEnabled(theirs.id, true));
    const othersDelete = await outcome(triggers.delete(ownersTrigger.id));
    await triggers.delete(theirs.id);

    expect({
      listed,
      move,
      disabled: disabled.enabled,
      enable,
      othersDelete,
      left: await owner.api.workflowResources.triggers.list(workflow),
    }).toStrictEqual({
      listed: [theirs],
      move: "workflow.resource_unavailable",
      disabled: false,
      enable: "workflow.resource_unavailable",
      othersDelete: "workflow.trigger_unavailable",
      left: [ownersTrigger],
    });
  });

  it("are neither listed, created nor deleted by Grasp staff", async () => {
    const { workflow, trigger } = await ownerWithTrigger();
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(session);
    const { triggers } = core.authenticate().workflowResources;

    expect({
      list: await outcome(triggers.list(workflow)),
      create: await outcome(
        triggers.create({
          kind: "schedule",
          workflowId: workflow,
          version: 1,
          config: nightly,
        })
      ),
      disable: await outcome(triggers.setEnabled(trigger.id, false)),
      delete: await outcome(triggers.delete(trigger.id)),
    }).toStrictEqual({
      list: "role.forbidden",
      create: "role.forbidden",
      disable: "role.forbidden",
      delete: "role.forbidden",
    });
  });

  it("show a connector trigger's connection, event and mapping as created", async () => {
    const owner = await personApi("builder");
    const workflow = await reporting(owner);
    const connectionId = `connection-${unique()}`;
    const now = Date.now();
    await connectDb()
      .prepare(
        "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tools, account_name, account_email, created_at, updated_at) VALUES (?, 'microsoft', 'personal', ?, 'active', 'native', 'microsoft-365', '[]', ?, ?, ?, ?)"
      )
      .bind(connectionId, owner.userId, "Mail", "mail@acme.test", now, now)
      .run();
    const config = {
      connection: { connectionId, resource: "reports@acme.test" },
      event: "m365.mail.received",
      input: { fields: { report: "/payload/subject" }, defaults: {} },
    };

    const trigger = await owner.api.workflowResources.triggers.create({
      kind: "connector",
      workflowId: workflow,
      version: 1,
      config,
    });

    expect({
      config: trigger.config,
      nextAt: trigger.nextAt,
      listed: await owner.api.workflowResources.triggers.list(workflow),
    }).toStrictEqual({ config, nextAt: null, listed: [trigger] });
  });

  it("ask an admin, as a connector trigger is created, to start and to read its event on exactly its connection, named by what they are, and once granted hear and start", async () => {
    const owner = await personApi("builder");
    const decider = await personApi("admin");
    const workflow = await reporting(owner);
    const connectionId = `connection-${unique()}`;
    const now = Date.now();
    await connectDb()
      .prepare(
        "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tools, account_name, account_email, created_at, updated_at) VALUES (?, 'microsoft', 'personal', ?, 'active', 'native', 'microsoft-365', '[]', ?, ?, ?, ?)"
      )
      .bind(connectionId, owner.userId, "Mail", "mail@acme.test", now, now)
      .run();
    const mailbox = "reports@acme.test";
    const { triggers } = owner.api.workflowResources;
    const trigger = await triggers.create({
      kind: "connector",
      workflowId: workflow,
      version: 1,
      config: {
        connection: { connectionId, resource: mailbox },
        event: "m365.mail.received",
        input: { fields: { report: "/payload/subject" }, defaults: {} },
      },
    });
    const schedule = await nightlyTrigger(owner, workflow);
    const standing = async () => {
      const listed = await triggers.list(workflow);
      return listed.map(({ id, start, events }) => ({
        id,
        start,
        events,
      }));
    };
    // What the admin's pending list shows of these triggers' requests.
    const waitingFor = async () => {
      const { items } = await decider.api.waiting.list();
      return items.flatMap((item) =>
        item.kind === "permissionRequest" &&
        item.request.subject.type === "trigger" &&
        [trigger.id, schedule.id].includes(item.request.subject.triggerId)
          ? [item.request]
          : []
      );
    };
    const settle = async (id: string, verdict: "grant" | "reject") => {
      await decider.api.waiting.settle(
        verdict === "grant"
          ? {
              kind: "permissionRequest",
              id,
              verdict,
              reviewed: { version: null },
            }
          : { kind: "permissionRequest", id, verdict }
      );
    };
    const listening = async () => {
      const listeners = await listenersOf(env);
      return listeners.some(
        (listener) =>
          listener.connection === connectionId &&
          listener.resource === mailbox &&
          listener.owner === owner.userId
      );
    };
    const event = (id: string) => ({
      id,
      connection: connectionId,
      owner: owner.userId,
      resource: mailbox,
      action: "mail.list",
      type: "m365.mail.received",
      payload: { subject: "Weekly" },
    });

    const asked = await waitingFor();
    const created = {
      standing: await standing(),
      // In the feed's order, which this test doesn't decide: the
      // connector trigger's first, each start before its events.
      shown: asked
        .map(({ subject, object, actions, binding, trigger: what }) => ({
          subject,
          object,
          actions,
          binding,
          trigger: what,
        }))
        .toSorted(
          (one, other) =>
            Number(triggerOf(one) === schedule.id) -
              Number(triggerOf(other) === schedule.id) ||
            other.binding.localeCompare(one.binding)
        ),
      listening: await listening(),
    };
    // Refused its events, then asked again for them as the tab does.
    const events = asked.find(({ binding }) => binding === "EVENTS");
    await settle(events?.id ?? "", "reject");
    const refused = await standing();
    const again = triggerEventsRequest(
      trigger.id,
      { connectionId, resource: mailbox },
      "m365.mail.received"
    );
    if (again === undefined) {
      throw new Error("Expected a request for its events");
    }
    await owner.api.permissions.request(again);
    for (const each of await waitingFor()) {
      if (triggerOf(each) === trigger.id) {
        // oxlint-disable-next-line no-await-in-loop -- one decision after another
        await settle(each.id, "grant");
      }
    }
    const granted = {
      standing: await standing(),
      listening: await listening(),
      delivered: await deliverConnectorEvent(env, event(crypto.randomUUID())),
    };

    const subject = { type: "trigger", triggerId: trigger.id };
    const summary = {
      kind: "connector",
      schedule: null,
      event: "m365.mail.received",
      connection: { connectionId, resource: mailbox },
    };
    expect({ created, refused, granted }).toStrictEqual({
      created: {
        standing: [
          { id: trigger.id, start: "requested", events: "requested" },
          { id: schedule.id, start: "requested", events: null },
        ],
        shown: [
          { ...triggerStartRequest(trigger.id, workflow), trigger: summary },
          {
            subject,
            object: { type: "connection", connectionId, resource: mailbox },
            actions: ["mail.list"],
            binding: "EVENTS",
            trigger: summary,
          },
          {
            ...triggerStartRequest(schedule.id, workflow),
            trigger: {
              kind: "schedule",
              schedule: nightly.schedule,
              event: null,
              connection: null,
            },
          },
        ],
        listening: false,
      },
      refused: [
        { id: trigger.id, start: "requested", events: "revoked" },
        { id: schedule.id, start: "requested", events: null },
      ],
      granted: {
        standing: [
          { id: trigger.id, start: "active", events: "active" },
          { id: schedule.id, start: "requested", events: null },
        ],
        listening: true,
        delivered: { runs: 1 },
      },
    });
  });
});
