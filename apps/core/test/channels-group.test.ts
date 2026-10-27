import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { newTeam, readCollection } from "./brain-collections.ts";
import { botConnectorMembersUrl, teamsBot } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { callAuth, signedInApi, unique } from "./sign-in.ts";
import {
  kept,
  member,
  memberAnsweredBy,
  messageFrom,
  post,
  providers,
  reached,
  teamsPerson,
  watched,
} from "./teams-door.ts";
import type { TeamsPerson } from "./teams-door.ts";

// Stephen asked in a Teams group chat or channel (src/channels/door.ts):
// only a message that @mentions him is taken, and its answer reads only
// what everyone in the conversation may read, as Teams' roster names them
// (src/brain/access.ts). The turn runs in the asker's own Workspace
// object, with the model gateway faked behind it, and the roster and the
// answer go through connect to the fake Bot Connector.

const idp = mockIdp();

watched();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 90_000 };

/** A new group chat's conversation id, as Teams names one. */
const newGroup = (): string => `19:${unique()}@thread.v2`;

/** A message `person` sent in `conversation`, @mentioning Stephen. */
const mentionIn = (
  person: TeamsPerson,
  conversation: string,
  text: string,
  conversationType: "groupChat" | "channel" = "groupChat"
) =>
  messageFrom(person, {
    text: `<at>Stephen</at> ${text}`,
    conversation: { id: conversation, conversationType, tenantId: acmeTenant },
    entities: [
      {
        type: "mention",
        text: "<at>Stephen</at>",
        mentioned: { id: `28:${teamsBot.id}`, name: "Stephen" },
      },
    ],
  });

/** Puts each of `people` on `conversation`'s roster, as Teams has them. */
const onGroupRoster = async (
  conversation: string,
  people: { person: TeamsPerson; userRole?: string; tenantId?: string }[]
): Promise<void> => {
  await providers().fetch(botConnectorMembersUrl, {
    method: "POST",
    body: JSON.stringify({
      members: Object.fromEntries(
        people.map(({ person, userRole = "user", tenantId = acmeTenant }) => [
          `${conversation} ${person.userId}`,
          {
            id: person.userId,
            aadObjectId: person.aadObjectId,
            userRole,
            tenantId,
          },
        ])
      ),
    }),
  });
};

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

/**
 * A handbook for everyone and a collection for one team, each with one
 * document, that the organization's agent may read; and the team's id.
 */
const handbookAndTeamNotes = async () => {
  const admin = await signedInApi(idp, "admin");
  const teamId = await newTeam(admin, []);
  const [handbook, team] = await Promise.all([
    admin.api.brain.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    }),
    admin.api.brain.createCollection({
      name: `Bonus ${unique()}`,
      access: "teams",
      teams: [teamId],
    }),
  ]);
  const [lunch, bonus] = await Promise.all([
    admin.api.brain.saveDocument({
      collectionId: handbook.id,
      path: "lunch.md",
      text: "# Lunch\n\nLunch is served at noon.",
      ifVersion: 0,
    }),
    admin.api.brain.saveDocument({
      collectionId: team.id,
      path: "bonus.md",
      text: "# Bonus\n\nThe bonus pool is forty thousand.",
      ifVersion: 0,
    }),
  ]);
  for (const collectionId of [handbook.id, team.id]) {
    // oxlint-disable-next-line no-await-in-loop -- one grant at a time
    await requestGranted(
      idp,
      admin,
      readCollection(
        { type: "agent", agentId: chatAgentId },
        collectionId,
        `C${unique()}`.toUpperCase()
      )
    );
  }
  return { admin, teamId, lunchId: lunch.id, bonusId: bonus.id };
};

/** The agent's code: each document's text, or `unreadable`. */
const readsBoth = (lunchId: string, bonusId: string) =>
  codeStep(`export default async (self, env) => {
  const read = async (id) => {
    try {
      return (await env.brain.read(id)).text;
    } catch {
      return "unreadable";
    }
  };
  return { lunch: await read(${JSON.stringify(lunchId)}), bonus: await read(${JSON.stringify(bonusId)}) };
};`);

/** What the model was told after the code at `index` of its requests ran. */
const toldAfter = (
  gateway: { requests: readonly { body: unknown }[] },
  index: number
) => {
  const told = JSON.stringify(gateway.requests[index]?.body ?? null);
  return {
    lunch: told.includes("Lunch is served at noon"),
    bonus: told.includes("The bonus pool is forty thousand"),
  };
};

/** Adds `userId` to the team `teamId`, as an admin does. */
const addToTeam = async (
  admin: { session: string },
  teamId: string,
  userId: string
): Promise<void> => {
  const added = await callAuth("/organization/add-team-member", admin.session, {
    teamId,
    userId,
  });
  if (!added.ok) {
    throw new Error(`Adding ${userId} to the team failed`);
  }
};

describe("in a group chat", setUpTime, () => {
  it("an answer reads only what every member may read, though the asker may read more", async () => {
    const { admin, teamId, lunchId, bonusId } = await handbookAndTeamNotes();
    const ann = await member(
      idp,
      readsBoth(lunchId, bonusId),
      says("In private."),
      readsBoth(lunchId, bonusId),
      says("In the group.")
    );
    const bo = await memberAnsweredBy(idp, ann.gateway);
    await addToTeam(admin, teamId, ann.userId);
    const group = newGroup();
    await onGroupRoster(group, [{ person: ann.teams }, { person: bo.teams }]);

    await post(messageFrom(ann.teams, { text: "What's the bonus pool?" }));
    await post(mentionIn(ann.teams, group, "What's the bonus pool?"));

    const { activities, asked } = await reached(group);
    expect({
      // Ann alone reads her team's note; with Bo in the chat, her answer
      // doesn't, and the handbook is still read.
      alone: toldAfter(ann.gateway, 1),
      together: toldAfter(ann.gateway, 3),
      answered: JSON.stringify(activities).includes("In the group."),
      rosterRead: asked.includes(`${group} *`),
      // The group isn't anyone's private conversation.
      kept: await kept(group),
    }).toStrictEqual({
      alone: { lunch: true, bonus: true },
      together: { lunch: true, bonus: false },
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

  it("reads what a team shares when every member is in it", async () => {
    const { admin, teamId, lunchId, bonusId } = await handbookAndTeamNotes();
    const ann = await member(
      idp,
      readsBoth(lunchId, bonusId),
      says("All of us.")
    );
    const bo = await memberAnsweredBy(idp, ann.gateway);
    await addToTeam(admin, teamId, ann.userId);
    await addToTeam(admin, teamId, bo.userId);
    const group = newGroup();
    await onGroupRoster(group, [{ person: ann.teams }, { person: bo.teams }]);

    await post(mentionIn(ann.teams, group, "What's the bonus pool?"));

    expect(toldAfter(ann.gateway, 1)).toStrictEqual({
      lunch: true,
      bonus: true,
    });
  });

  it("a guest narrows it to nothing, as does someone Grasp hasn't seen", async () => {
    const { lunchId, bonusId } = await handbookAndTeamNotes();
    const ann = await member(
      idp,
      readsBoth(lunchId, bonusId),
      says("A guest is here."),
      readsBoth(lunchId, bonusId),
      says("A stranger is here.")
    );
    const withGuest = newGroup();
    await onGroupRoster(withGuest, [
      { person: ann.teams },
      { person: teamsPerson(), userRole: "guest" },
    ]);
    const withStranger = newGroup();
    await onGroupRoster(withStranger, [
      { person: ann.teams },
      { person: teamsPerson() },
    ]);

    await post(mentionIn(ann.teams, withGuest, "When is lunch?"));
    await post(mentionIn(ann.teams, withStranger, "When is lunch?", "channel"));

    expect(toldAfter(ann.gateway, 1)).toStrictEqual({
      lunch: false,
      bonus: false,
    });
    expect(toldAfter(ann.gateway, 3)).toStrictEqual({
      lunch: false,
      bonus: false,
    });
    const { activities } = await reached(withGuest);
    expect(JSON.stringify(activities)).toContain("A guest is here.");
  });

  it("gives the agent no way to act or hold a write, only to read", async () => {
    const actsWith = codeStep(
      `export default async (self, env) => ["connections", "apps", "build", "workflows", "memory", "brain", "brain"].filter((name) => env[name] !== undefined).join(",");`
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
      JSON.stringify(ann.gateway.requests[index]?.body ?? null);
    expect(told(1)).toContain("connections,apps,build,workflows,memory");
    expect(told(3)).toContain('\\"brain\\"');
    expect(told(3)).not.toContain("connections,");
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
    expect(ann.gateway.requests).toHaveLength(0);
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
