import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { pointAtGateway, says } from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, clientOrigin, otherTenant } from "./sign-in-config.ts";
import { entraPerson, signedIn, whoami } from "./sign-in.ts";
import {
  kept,
  messageFrom,
  onRoster,
  post,
  reached,
  teamsPerson,
  watched,
} from "./teams-door.ts";
import type { TeamsPerson } from "./teams-door.ts";

// One of the client's own people whom Grasp hasn't seen, writing on Teams
// (src/channels/door.ts): a link to the deployment's own sign-in, once a
// day, that binds nothing by itself; once they sign in with the mock IdP,
// their next message is answered, and the question they first asked with
// it. Nobody from outside the client's tenant is ever sent the link.

const idp = mockIdp();

watched();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const signInLink = `${clientOrigin}/sign-in`;

/** The cards and lines sent in `conversation`, each as JSON. */
const sentIn = async (conversation: string): Promise<string[]> => {
  const { activities } = await reached(conversation);
  return activities
    .filter(({ type }) => type === "message")
    .map((activity) => JSON.stringify(activity));
};

/** Someone of the client's tenant whom Grasp hasn't seen, as Teams' roster has them. */
const newcomer = async (): Promise<TeamsPerson> => {
  const person = teamsPerson(`entra-oid-${crypto.randomUUID()}`);
  await onRoster(person, { userRole: "user", tenantId: acmeTenant });
  return person;
};

/** `oid` signs in to Grasp with the mock IdP; their chats are answered by `replies`. */
const signsIn = async (
  oid: string,
  ...replies: Parameters<typeof says>[0][]
) => {
  const session = await signedIn(
    idp,
    "microsoft",
    entraPerson(acmeTenant, "acme.test", { oid })
  );
  const { userId } = await whoami(session);
  const gateway = fakeGateway(...replies.map((text) => says(text)));
  await pointAtGateway(workspace(env, personalWorkspaceId(userId)), gateway);
  return { userId, gateway };
};

describe("one of the client's people Grasp hasn't seen", setUpTime, () => {
  it("is sent the link to the deployment's own sign-in, once a day", async () => {
    const person = await newcomer();

    await post(messageFrom(person, { locale: "nl-NL" }));
    await post(messageFrom(person));

    const sent = await sentIn(person.conversation);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(signInLink);
    expect(sent[0]).toContain("Ik ken je nog niet.");
    // The link holds nothing of theirs: no token, no id.
    expect(sent[0]).not.toContain(`${signInLink}?`);
    await expect(kept(person.conversation)).resolves.toStrictEqual([]);
  });

  it("is answered once they've signed in, the question they first asked first", async () => {
    const person = await newcomer();
    await post(messageFrom(person, { text: "How long is parental leave?" }));

    const { userId, gateway } = await signsIn(
      person.aadObjectId,
      "Sixteen weeks.",
      "You're welcome."
    );
    await post(messageFrom(person, { text: "Thanks, I've signed in." }));

    await expect(kept(person.conversation)).resolves.toStrictEqual([
      { platform: "teams", userId },
    ]);
    expect(gateway.requests).toHaveLength(2);
    expect(JSON.stringify(gateway.requests[0]?.body)).toContain(
      "How long is parental leave?"
    );
    const sent = await sentIn(person.conversation);
    expect(
      sent.slice(1).map((each) => each.includes("Sixteen weeks."))
    ).toStrictEqual([true, false]);
  });

  it("asks once: the question kept is answered with the next message alone", async () => {
    const person = await newcomer();
    await post(messageFrom(person, { text: "Where's the handbook?" }));
    const { gateway } = await signsIn(
      person.aadObjectId,
      "In Knowledge.",
      "Hello again.",
      "Bye."
    );

    await post(messageFrom(person, { text: "Hi" }));
    await post(messageFrom(person, { text: "Bye" }));

    expect(gateway.requests).toHaveLength(3);
  });

  it("isn't known by a sign-in with another object id", async () => {
    const person = await newcomer();
    await post(messageFrom(person, { text: "What's on today?" }));
    const someoneElse = await signsIn(
      `entra-oid-${crypto.randomUUID()}`,
      "Not for you."
    );

    await post(messageFrom(person, { text: "Hello?" }));

    await expect(kept(person.conversation)).resolves.toStrictEqual([]);
    expect(someoneElse.gateway.requests).toHaveLength(0);
    // The link was sent today already: nothing more.
    await expect(sentIn(person.conversation)).resolves.toHaveLength(1);
  });
});

describe("someone from outside the client's tenant", setUpTime, () => {
  it("is never sent the link, from another company or as a guest", async () => {
    const outsider = teamsPerson();
    await onRoster(outsider, { userRole: "user", tenantId: otherTenant });
    const guest = teamsPerson();
    await onRoster(guest, { userRole: "guest", tenantId: acmeTenant });

    await post(messageFrom(outsider));
    await post(messageFrom(guest));

    const sent = [
      ...(await sentIn(outsider.conversation)),
      ...(await sentIn(guest.conversation)),
    ];
    expect(sent).toHaveLength(2);
    expect(sent.some((each) => each.includes(signInLink))).toBeFalsy();
  });
});
