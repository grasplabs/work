import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  model,
  configureObject,
  says,
} from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import { fakeProvider } from "./model-provider.ts";
import {
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  whoami,
} from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// Work marked as a Grasp staff member's (GRA-1088): a staff session no
// longer starts work of its own (staff-scope.test.ts), but core still
// carries the mark on a turn until that code goes. What it lets through,
// tried here at the Workspace object core's chats call:
// 1. A marked turn goes ahead as the staff member, under the agent's
//    grants, and no further.
// 2. A member's turn passes as staff's, or staff's as a member's, or
//    staff's goes on once the staff session has ended.

const idp = mockIdp();

/** A staff session's user ID. */
const staffOn = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { userId } = await whoami(session);
  return { userId };
};

/** Ends every staff session of `userId`, as their sign-out or expiry would. */
const staffSessionsEnd = async (userId: string): Promise<void> => {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND staff = 1")
    .bind(userId)
    .run();
};

/** `someone`'s own chats, answered by the agent saying `text`. */
const answering = async (someone: { userId: string }, text: string) => {
  await fakeProvider(says(text));
  await configureObject(workspace(env, personalWorkspaceId(someone.userId)));
};

/** A new chat in `someone`'s own chats, as core's chats make one. */
const chatFor = async (someone: { userId: string }) =>
  await workspace(env, personalWorkspaceId(someone.userId)).createChat(
    "Check",
    someone.userId,
    chatAgentId
  );

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

describe("a turn marked as Grasp staff's", () => {
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

    // As core's chats would send a staff member's question: marked.
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
    const staffChat = await chatFor(staff);
    const memberChat = await chatFor(member);
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
