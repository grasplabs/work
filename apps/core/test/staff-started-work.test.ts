import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import type { ChatUpdate } from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { appHost, workspace } from "../src/durable-objects.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  model,
  configureObject,
  says,
} from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import { fakeProvider } from "./model-provider.ts";
import { finished, stepDone, woken } from "./runs.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  whoami,
} from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// Work a Grasp staff member starts (GRA-1088, its threat model): a
// workflow run they start, or a turn they ask in their own chat, goes
// ahead with their access, through the same checks, and everything it
// does is in the client's audit log as theirs, "(Grasp staff)". The ways
// it can fail, tried here:
// 1. Staff-started work does something the log doesn't tie to staff.
// 2. A member's work is marked as staff's, or staff's isn't.
// 3. Staff-started work goes on once the staff session has ended.

const idp = mockIdp();

/** A staff session's API and user ID, on a connection of its own. */
const staffOn = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  const { userId } = await whoami(session);
  return { api: core.authenticate(), userId };
};

/** Ends every staff session of `userId`, as their sign-out or expiry would. */
const staffSessionsEnd = async (userId: string): Promise<void> => {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND staff = 1")
    .bind(userId)
    .run();
};

/** The staff member each actor names as having started the work, if any. */
const staffOf = (actors: readonly AuditActor[]): (string | undefined)[] =>
  actors.map((actor) => ("staff" in actor ? actor.staff : undefined));

/** The events that name `id`, oldest first. */
const eventsNaming = async (id: string): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter((event) => JSON.stringify(event).includes(id));
};

/** Whether the run's row says staff started it. */
const markedStaff = async (run: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT started_by_staff AS staff FROM workflow_runs WHERE id = ?"
  )
    .bind(run)
    .first<{ staff: number }>();
  return row?.staff === 1;
};

/** An App of a new builder's with one workflow, `report`, of `body`. */
const appRunning = async (body: string, mocks: Record<string, unknown>) => {
  const builder = await signedInApi(idp, "builder");
  const app = await appWith(builder, workflowFiles("report", body, mocks));
  return { builder, app };
};

describe("a workflow run Grasp staff start", () => {
  it("runs with their access, and every event after its start names them; a member's names no one", async () => {
    const { builder, app } = await appRunning(
      `  return await step.do("total", { description: "Read" }, async () => 1);`,
      { total: 1 }
    );
    const staff = await staffOn();

    const byStaff = await staff.api.workflows.start(app, "report");
    const byMember = await builder.api.workflows.start(app, "report");
    await finished(byStaff.id);
    await finished(byMember.id);

    const runOutcome = async (run: string) => {
      const [started, ...after] = await eventsNaming(run);
      const { status } = await builder.api.workflows.status(run);
      return {
        status,
        marked: await markedStaff(run),
        started: started?.actor.type,
        after: [...new Set(staffOf(after.map(({ actor }) => actor)))],
      };
    };
    const outcomes = {
      staff: await runOutcome(byStaff.id),
      member: await runOutcome(byMember.id),
    };
    // Searched by the staff member's ID, as an admin would: what the run
    // did for them is found with what they did themselves.
    const admin = await signedInApi(idp, "admin");
    const found = await admin.api.audit.search({
      actorId: staff.userId,
      targetId: byStaff.id,
    });
    const foundTypes = found.records.map(
      ({ event }) => event?.actor.type ?? ""
    );

    expect({
      ...outcomes,
      searched: [...new Set(foundTypes)].toSorted((a, b) => a.localeCompare(b)),
    }).toStrictEqual({
      staff: {
        status: "completed",
        marked: true,
        started: "staff",
        after: [staff.userId],
      },
      member: {
        status: "completed",
        marked: false,
        started: "person",
        after: [undefined],
      },
      searched: ["staff", "workflow"],
    });
  });

  it("stops before its next step once their staff session has ended", async () => {
    const { app } = await appRunning(
      `  await step.do("first", { description: "First" }, async () => 1);
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("book", { description: "Book" }, async () => 2);`,
      { first: 1, book: 2 }
    );
    const staff = await staffOn();

    const run = await staff.api.workflows.start(app, "report");
    await stepDone(run.id, "first");
    await staffSessionsEnd(staff.userId);
    await woken(run.id);
    await finished(run.id);

    // What the run did is the client's admins' to read.
    const admin = await signedInApi(idp, "admin");
    const { status, failure } = await admin.api.workflows.status(run.id);
    expect({ status, code: failure?.error.code }).toStrictEqual({
      status: "failed",
      code: "permission.person_inactive",
    });
  });
});

/** `someone`'s own chats, answered by the agent saying `text`. */
const answering = async (someone: { userId: string }, text: string) => {
  await fakeProvider(says(text));
  await configureObject(workspace(env, personalWorkspaceId(someone.userId)));
};

/** Sends `text` in a new chat of `chats`' and waits for its answer. */
const asked = async (
  chats: {
    create: (title: string) => Promise<{ id: string }>;
    send: (
      id: string,
      question: { text: string; model: string }
    ) => Promise<void>;
    watch: (
      id: string,
      after: null,
      onUpdate: (update: ChatUpdate) => void
    ) => Promise<unknown>;
  },
  text: string
): Promise<string> => {
  const chat = await chats.create("Check");
  const updates: ChatUpdate[] = [];
  await chats.watch(chat.id, null, (update) => {
    updates.push(update);
  });
  await chats.send(chat.id, { text, model });
  await vi.waitFor(
    () => {
      expect({
        running: updates.at(-1)?.running,
        last: updates.flatMap(({ messages }) => messages).at(-1)?.role,
      }).toStrictEqual({ running: false, last: "assistant" });
    },
    { timeout: 10_000 }
  );
  return chat.id;
};

/** Who the model calls of `personId`'s turns were made for, as audited. */
const modelCallsFor = async (personId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, actor }) =>
        action === "model.call" &&
        actor.type === "agent" &&
        actor.onBehalfOf === personId
    )
    .map(({ actor }) => actor);
};

/**
 * Asks in `someone`'s chat `chatId` as core's chats call their object,
 * the turn marked as staff's or not.
 */
const sent = async (
  someone: { userId: string },
  chatId: string,
  marked: boolean
) =>
  await outcome(
    workspace(env, personalWorkspaceId(someone.userId)).send(
      chatId,
      someone.userId,
      { text: "Still there?", model },
      marked
    )
  );

describe("a turn Grasp staff ask in their own chat", () => {
  it("names them on the restricted mode a fix chat of theirs starts in", async () => {
    const { builder, app } = await appRunning(
      `  await step.do("check", { description: "Check" }, async () => {
    throw new Error("Customer c-1 is blocked");
  });`,
      { check: null }
    );
    await appHost(env, appIdSchema.parse(app)).restrict();
    const started = await builder.api.workflows.start(app, "report");
    await finished(started.id);
    const staff = await staffOn();
    await answering(staff, "Looking.");

    const { chat } = await staff.api.chats.fixRun(started.id, model);
    const events = await allEvents();
    const restricted = events.filter(
      ({ action, target }) =>
        action === "context.restricted" && target?.id === chat.id
    );

    expect(staffOf(restricted.map(({ actor }) => actor))).toStrictEqual([
      staff.userId,
    ]);
  });

  it("is answered, and its model call names them; a member's names no one", async () => {
    const staff = await staffOn();
    const member = await signedInApi(idp, "user");
    await answering(staff, "All in order.");
    await answering(member, "All in order.");

    await asked(staff.api.chats, "Is the setup in order?");
    await asked(member.api.chats, "Is the setup in order?");

    expect({
      staff: staffOf(await modelCallsFor(staff.userId)),
      member: staffOf(await modelCallsFor(member.userId)),
    }).toStrictEqual({ staff: [staff.userId], member: [undefined] });
  });

  it("calls the agent's ordinary tools as them, under the agent's grants", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "report",
        `  return await step.do("total", { description: "Read" }, async () => 1);`,
        { total: 1 }
      )
    );
    const staff = await staffOn();
    const listed = `export default async (self, env) => {
      const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
      return {
        apps: await tried(async () => (await env.apps.list()).map(({ id }) => id)),
        workflows: await tried(async () => (await env.workflows.list()).map(({ workflow }) => workflow)),
      };
    };`;
    const chat = await chatOf(staff.userId, codeStep(listed), says("Done."));
    // The agent still needs its grants, as for anyone's turn.
    await requestGranted(
      idp,
      admin,
      readCollection(chat.agent, "apps", "APP_LIBRARY")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "app", appId: app },
      actions: ["read"],
      binding: "REPORT",
    });

    // As core's chats send a staff member's question: marked.
    await chat.stub.send(
      chat.chat.id,
      staff.userId,
      { text: "List", model },
      true
    );
    const returned = await vi.waitFor(
      async () => {
        const [result] = await codeResults(chat.stub, chat.chat.id);
        expect(result).toBeDefined();
        const parsed: unknown = JSON.parse(
          result?.text.replace("Returned:\n", "") ?? "null"
        );
        return parsed;
      },
      { timeout: 10_000 }
    );

    // Every App the staff role sees, this one among them.
    const apps: unknown = expect.arrayContaining([app]);
    expect(returned).toStrictEqual({
      apps,
      workflows: ["report"],
    });
  });

  it("goes ahead only with the mark core sets, and only while their staff session lasts", async () => {
    const staff = await staffOn();
    const member = await signedInApi(idp, "user");
    await answering(staff, "All in order.");
    await answering(member, "All in order.");
    const staffChat = await staff.api.chats.create("Check");
    const memberChat = await member.api.chats.create("Check");
    const unmarkedStaff = await sent(staff, staffChat.id, false);
    const markedMember = await sent(member, memberChat.id, true);
    await staffSessionsEnd(staff.userId);
    const staffGone = await sent(staff, staffChat.id, true);

    expect({ unmarkedStaff, markedMember, staffGone }).toStrictEqual({
      unmarkedStaff: "permission.person_inactive",
      markedMember: "permission.person_inactive",
      staffGone: "permission.person_inactive",
    });
  });
});
