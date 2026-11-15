import type { InstructionFileRef } from "@grasp-os/shared/instruction-files";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appKind } from "../src/apps.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { keepMadeInChat } from "../src/drafts.ts";
import { workspace } from "../src/durable-objects.ts";
import { codeStep, model, says } from "./agent-chat.ts";
import { botConnectorMembersUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { saveInstructions } from "./instruction-saves.ts";
import { fakeProvider } from "./model-provider.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { signedInApi, unique } from "./sign-in.ts";
import {
  kept,
  member,
  memberAnsweredBy,
  mentionIn,
  messageFrom,
  newGroup,
  onGroupRoster,
  post,
  providers,
  reached,
  teamsPerson,
  watched,
} from "./teams-door.ts";

// Stephen asked in a Teams group chat or channel (src/channels/door.ts):
// only a message that @mentions him is taken, and its answer reads only
// what everyone in the conversation may read, as Teams' roster names them
// (turn-recall.ts). The turn runs in the asker's own Workspace
// object, with the model provider faked behind connect, and the roster and the
// answer go through connect to the fake Bot Connector.

const idp = mockIdp();

watched();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 90_000 };

/** A request that offers any of the agent's tools besides code (agent-tools.ts). */
const dedicated =
  /"name":"(?<tool>createApp|readFile|writeFile|editFile|searchFiles|searchBrain|requestConnection|editWorkflow)"/u;

/** The person's chats, as their Workspace keeps them. */
const chatsOf = async (userId: string) =>
  await runInDurableObject(
    workspace(env, personalWorkspaceId(userId)),
    (_instance, state) =>
      state.storage.sql
        .exec<{
          id: string;
          title: string;
          via: string;
          thread: string | null;
        }>(
          "SELECT id, title, via, thread FROM chats WHERE person_id = ? ORDER BY created_at",
          userId
        )
        .toArray()
  );

/** Saves `text` as the next version of `file`, as `by` does from a page. */
const save = async (
  by: Awaited<ReturnType<typeof signedInApi>>,
  file: InstructionFileRef,
  text: string
) => await saveInstructions(by.api, file, text);

describe("in a group chat", setUpTime, () => {
  it("answers in a chat of its own for the group, read from its roster, which is nobody's private conversation", async () => {
    const ann = await member(idp, says("In private."), says("In the group."));
    const bo = await memberAnsweredBy(idp, ann.provider);
    const group = newGroup();
    await onGroupRoster(group, [{ person: ann.teams }, { person: bo.teams }]);

    await post(messageFrom(ann.teams, { text: "What's the bonus pool?" }));
    await post(mentionIn(ann.teams, group, "What's the bonus pool?"));

    const { activities, asked } = await reached(group);
    expect({
      answered: JSON.stringify(activities).includes("In the group."),
      rosterRead: asked.includes(`${group} *`),
      // The group isn't anyone's private conversation.
      kept: await kept(group),
    }).toStrictEqual({
      answered: true,
      rosterRead: true,
      kept: [],
    });
    // Her own chat, and her one chat for the group, apart.
    await expect(chatsOf(ann.userId)).resolves.toMatchObject([
      { title: "Microsoft Teams", via: "teams", thread: null },
      { title: "Microsoft Teams group chat", via: "teams" },
    ]);
  });

  it("gives the agent no way to act or hold a write, only to read", async () => {
    const actsWith = codeStep(
      `export default async (self, env) => ["connections", "apps", "build", "workflows", "brain", "knowledge"].filter((name) => { try { return env[name] !== undefined; } catch { return false; } }).join(",");`
    );
    const ann = await member(
      idp,
      actsWith,
      says("Private."),
      actsWith,
      says("Group.")
    );
    const group = newGroup();
    await onGroupRoster(group, [{ person: ann.teams }]);

    await post(messageFrom(ann.teams, { text: "What can you do?" }));
    await post(mentionIn(ann.teams, group, "What can you do?"));

    const told = (index: number) =>
      JSON.stringify(ann.provider.requests[index]?.body ?? null);
    // Neither has Knowledge, which no chat reads since the Brain replaced
    // it: in private the agent's APIs, in the group none of them.
    expect(told(1)).toContain('"Returned:\\nconnections,apps,build,workflows"');
    expect(told(3)).toContain('"Returned:\\n"');
    // Nor any of the tools that write, ask for a connection or read the
    // brain: each calls an API the group's chat doesn't have.
    expect([dedicated.test(told(0)), dedicated.test(told(2))]).toStrictEqual([
      true,
      false,
    ]);
  });

  it("starts from the company's and the agent's instruction files, and never a person's, the asker's own included, in a group or a direct message", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await member(idp, says("In private."), says("In the group."));
    const u = unique();
    await save(
      admin,
      { scope: "company", name: "instructions" },
      `Company ${u}`
    );
    await save(admin, { scope: "agent", agentId: chatAgentId }, `Agent ${u}`);
    await save(ann, { scope: "person", personId: ann.userId }, `Ann's ${u}`);
    const group = newGroup();
    await onGroupRoster(group, [{ person: ann.teams }]);

    await post(messageFrom(ann.teams, { text: "Hi." }));
    await post(mentionIn(ann.teams, group, "Hi."));

    const told = (index: number) => {
      const body = JSON.stringify(ann.provider.requests[index]?.body ?? null);
      return [`Company ${u}`, `Agent ${u}`, `Ann's ${u}`].filter((marker) =>
        body.includes(marker)
      );
    };
    expect({ direct: told(0), group: told(1) }).toStrictEqual({
      // Her direct message isn't hers alone while GRA-1821 is open: the
      // chat app keeps its answer too (workspace.ts, `answersAlone`).
      direct: [`Company ${u}`, `Agent ${u}`],
      group: [`Company ${u}`, `Agent ${u}`],
    });
  });

  it("gives an App's file to its builder in their own chat in Grasp, never in their direct message", async () => {
    const provider = await fakeProvider(
      says("Hi."),
      says("Still here."),
      says("In Grasp.")
    );
    const ada = await memberAnsweredBy(idp, provider, "builder");
    const u = unique();
    const { id: appId } = await ada.api.apps.create({ name: `Desk ${u}` });
    await save(ada, { scope: "app", appId }, `App ${u}`);
    /** Keeps chat `chatId` as having worked on the App last, as Build it does. */
    const workedOn = async (chatId: string) => {
      await keepMadeInChat(env, appKind, appId, ada.userId, {
        chatId,
        turnId: null,
        callId: null,
      });
    };
    await post(messageFrom(ada.teams, { text: "Hi." }));
    const [direct] = await chatsOf(ada.userId);
    if (direct === undefined) {
      throw new TypeError("Expected her direct message's chat");
    }
    await workedOn(direct.id);
    await post(messageFrom(ada.teams, { text: "And now?" }));
    const own = workspace(env, personalWorkspaceId(ada.userId));
    const web = await own.createChat("In Grasp", ada.userId, chatAgentId);
    await workedOn(web.id);
    await own.ask(web.id, { text: "And here?", model });

    const told = (index: number) =>
      JSON.stringify(provider.requests[index]?.body ?? null).includes(
        `App ${u}`
      );
    expect({
      direct: { via: direct.via, toldApp: told(1) },
      web: told(2),
    }).toStrictEqual({
      // While GRA-1821 is open: the chat app keeps the answer too.
      direct: { via: "teams", toldApp: false },
      web: true,
    });
  });

  it("takes nothing not said to Stephen: no line, no roster read, no turn", async () => {
    const ann = await member(idp);
    const group = newGroup();

    await post(
      messageFrom(ann.teams, {
        text: "Lunch anyone?",
        conversation: {
          id: group,
          conversationType: "groupChat",
          tenantId: acmeTenant,
        },
      })
    );

    await expect(reached(group)).resolves.toStrictEqual({
      activities: [],
      sent: [],
      lines: [],
      asked: [],
    });
    expect(ann.provider.requests).toHaveLength(0);
  });

  it("answers someone from another company with their line, and reads nothing", async () => {
    const stranger = teamsPerson();
    const group = newGroup();
    await providers().fetch(botConnectorMembersUrl, {
      method: "POST",
      body: JSON.stringify({
        members: {
          [`${group} ${stranger.userId}`]: {
            id: stranger.userId,
            aadObjectId: stranger.aadObjectId,
            tenantId: crypto.randomUUID(),
          },
        },
      }),
    });

    await post(mentionIn(stranger, group, "Hello"));

    await expect(reached(group)).resolves.toMatchObject({
      lines: [
        "I only work for the people of the company that set me up, so I can't help you here.",
      ],
    });
  });
});
