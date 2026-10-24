import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { pointAtGateway, says } from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import {
  connectedDirectory,
  directoryHolds,
  directoryUser,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  entraPerson,
  signedIn,
  signedInApi,
  whoami,
} from "./sign-in.ts";
import {
  kept,
  messageFrom,
  onRoster,
  post,
  reached,
  teamsPerson,
  watched,
} from "./teams-door.ts";

// The client's people known from the organization's directory, without a
// first sign-in (GRA-748, src/auth/directory-members.ts): someone writing
// on Teams whom the directory holds by the object id Teams verified is
// made a member and answered at once. The ways it could go wrong come
// first: someone taken for another by email, someone the directory no
// longer holds (or never held as one of the client's own) answered, a
// removed member made again, one person made twice when they sign in.

const idp = mockIdp();

watched();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const signInLink = `${clientOrigin}/sign-in`;

/**
 * The directory connected by an admin, holding `users`, and a gateway
 * answering `replies`: Workspace objects share their env, so pointing the
 * admin's points the ones made for people from the directory too.
 */
const directoryWith = async (
  users: Record<string, unknown>[],
  ...replies: string[]
) => {
  await directoryHolds(users);
  const { admin } = await connectedDirectory(idp);
  const gateway = fakeGateway(...replies.map((text) => says(text)));
  await pointAtGateway(
    workspace(env, personalWorkspaceId(admin.userId)),
    gateway
  );
  return { admin, gateway };
};

/** The cards and lines sent in `conversation`, each as JSON. */
const sentIn = async (conversation: string): Promise<string[]> => {
  const { activities } = await reached(conversation);
  return activities
    .filter(({ type }) => type === "message")
    .map((activity) => JSON.stringify(activity));
};

/** Who Grasp has under the Entra object id `oid`: users and their addresses. */
const usersWith = async (oid: string) => {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT users.id AS userId, users.email AS email
       FROM accounts JOIN users ON users.id = accounts.user_id
      WHERE accounts.oid = ?`
  )
    .bind(oid)
    .all<{ userId: string; email: string }>();
  return results;
};

describe("someone the directory holds", setUpTime, () => {
  it("is answered on their first message, with no sign-in, as one member however often they write", async () => {
    const oid = crypto.randomUUID();
    const { gateway } = await directoryWith(
      [directoryUser({ id: oid, displayName: "Daan Bakker" })],
      "Sixteen weeks.",
      "You're welcome."
    );
    const person = teamsPerson(oid);

    const events = await auditedDuring(async () => {
      await post(messageFrom(person, { text: "How long is parental leave?" }));
    });
    await post(messageFrom(person, { text: "Thanks!" }));

    const users = await usersWith(oid);
    const [made] = users;
    const sent = await sentIn(person.conversation);
    expect({
      made: users.length,
      kept: await kept(person.conversation),
      answers: gateway.requests.length,
      link: sent.some((each) => each.includes(signInLink)),
      recorded: events
        .filter(({ action }) => action === "member.joined_from_directory")
        .map(({ actor, target }) => ({ actor, target })),
    }).toStrictEqual({
      made: 1,
      kept: [{ platform: "teams", userId: made?.userId }],
      answers: 2,
      link: false,
      recorded: [
        {
          actor: { type: "system" },
          target: { type: "user", id: made?.userId },
        },
      ],
    });
  });

  it("is that same member from their first Microsoft sign-in on, with their own address", async () => {
    const oid = crypto.randomUUID();
    const { gateway } = await directoryWith(
      [directoryUser({ id: oid, displayName: "Lisa Jansen" })],
      "Hello Lisa.",
      "Hello again."
    );
    const person = teamsPerson(oid);
    await post(messageFrom(person, { text: "Hi" }));
    const [made] = await usersWith(oid);

    const claims = entraPerson(acmeTenant, "acme.test", { oid });
    const session = await signedIn(idp, "microsoft", claims);
    await post(messageFrom(person, { text: "Hi again" }));

    const signedInAs = await whoami(session);
    expect({
      signedInAs: signedInAs.userId,
      users: await usersWith(oid),
      kept: await kept(person.conversation),
      answers: gateway.requests.length,
    }).toStrictEqual({
      signedInAs: made?.userId,
      users: [{ userId: made?.userId, email: claims.email }],
      kept: [{ platform: "teams", userId: made?.userId }],
      answers: 2,
    });
  });
});

describe("someone the directory doesn't vouch for", setUpTime, () => {
  it("is refused once the directory no longer holds them", async () => {
    const oid = crypto.randomUUID();
    const { gateway } = await directoryWith(
      [directoryUser({ id: oid })],
      "Answered.",
      "Not for you."
    );
    const person = teamsPerson(oid);
    await onRoster(person, { userRole: "user", tenantId: acmeTenant });
    await post(messageFrom(person));

    await directoryHolds([]);
    await post(messageFrom(person));

    const sent = await sentIn(person.conversation);
    expect({
      answers: gateway.requests.length,
      last: sent.at(-1)?.includes(signInLink),
    }).toStrictEqual({ answers: 1, last: true });
  });

  it("isn't answered as a guest or with their account turned off, nor ever made a member", async () => {
    const [guest, disabled] = [crypto.randomUUID(), crypto.randomUUID()];
    const { gateway } = await directoryWith(
      [
        directoryUser({ id: guest, userType: "Guest" }),
        directoryUser({ id: disabled, accountEnabled: false }),
      ],
      "Not for you."
    );

    for (const oid of [guest, disabled]) {
      // oxlint-disable-next-line no-await-in-loop -- one person after the other
      await post(messageFrom(teamsPerson(oid)));
    }

    expect({
      answers: gateway.requests.length,
      made: [...(await usersWith(guest)), ...(await usersWith(disabled))],
    }).toStrictEqual({ answers: 0, made: [] });
  });

  it("is never taken for a member who has their email address", async () => {
    const member = await signedInApi(idp, "user");
    const oid = crypto.randomUUID();
    const { gateway } = await directoryWith(
      [directoryUser({ id: oid, mail: member.person.email })],
      "Answered."
    );
    const person = teamsPerson(oid);

    await post(messageFrom(person));

    const [made] = await usersWith(oid);
    expect({
      answered: gateway.requests.length,
      asMember: made?.userId === member.userId,
      email: made?.email === member.person.email,
    }).toStrictEqual({ answered: 1, asMember: false, email: false });
  });

  it("isn't made a member again once an admin removed them", async () => {
    const oid = crypto.randomUUID();
    const { admin, gateway } = await directoryWith(
      [directoryUser({ id: oid })],
      "Answered.",
      "Not for you."
    );
    const person = teamsPerson(oid);
    await post(messageFrom(person));
    const [made] = await usersWith(oid);
    await admin.api.members.remove(made?.userId ?? "");

    await post(messageFrom(person));

    const sent = await sentIn(person.conversation);
    const users = await usersWith(oid);
    expect({
      answers: gateway.requests.length,
      users: users.length,
      last: sent.at(-1)?.includes("You no longer have access to Grasp"),
    }).toStrictEqual({ answers: 1, users: 1, last: true });
  });
});
