import { routerSecretHeader } from "@grasp-os/shared/router";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import worker from "../src/index.ts";
import { says } from "./agent-chat.ts";
import { consentCode } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, clientOrigin } from "./sign-in-config.ts";
import { coreOrigin } from "./sign-in.ts";
import {
  member,
  memberAnsweredBy,
  messageFrom,
  post,
  reached,
  watched,
} from "./teams-door.ts";
import { connectDb } from "./test-env.ts";

// A member's own Microsoft 365, connected from Teams (src/channels/
// connect-own.ts): answered without it, they get one card a day with a link
// to the deployment's own page; once they connect through connect's real
// flow, with connect's fake OAuth provider behind it, Stephen says so in
// Teams and answers what they asked again. These start from the ways it
// can fail: the link carries something that binds; someone else finishes
// the flow, or connects an account that isn't theirs, and Stephen carries
// on for them; a lapsed connection is never offered again; the card floods.

const idp = mockIdp();

watched();

/** Signing people in and connecting can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const connectLink = `${clientOrigin}/connect-microsoft`;

/** The cards to connect Microsoft 365 that reached `conversation`, as JSON. */
const connectCards = async (conversation: string): Promise<string[]> => {
  const { activities } = await reached(conversation);
  return activities
    .map((activity) => JSON.stringify(activity))
    .filter((activity) => activity.includes(connectLink));
};

/** The provider's redirect back, with `session`, run to its end. */
const backFromProvider = async (
  session: string,
  query: Record<string, string>
): Promise<Response> => {
  const headers = new Headers({ cookie: session });
  headers.set(routerSecretHeader, env.ROUTER_SECRET);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(
      `${coreOrigin}/api/connections/callback?${new URLSearchParams(query).toString()}`,
      { redirect: "manual", headers }
    ),
    env,
    ctx
  );
  // What it carries on in Teams runs after the browser is sent on.
  await waitOnExecutionContext(ctx);
  return response;
};

type Member = Awaited<ReturnType<typeof member>>;

/** `who` starts connecting their own Microsoft 365, as the page does. */
const started = async (who: Member) => {
  const { url } = await who.api.connections.start({
    provider: "microsoft",
    scope: "personal",
    returnTo: "/integrations",
  });
  return new URL(url);
};

/** The provider's consent for `flow`, with the account `subject`. */
const consented = (flow: URL, subject: string) => ({
  code: consentCode(flow, acmeTenant, subject),
  state: flow.searchParams.get("state") ?? "",
});

/** `who`'s object id, as their sign-in keeps it. */
const oidOf = (who: Member): string => who.teams.aadObjectId;

describe("a member's own Microsoft 365, from Teams", setUpTime, () => {
  it("is offered on one card a day when they have none, with a link that carries nothing of theirs", async () => {
    const ann = await member(idp, says("Hi."), says("Still here."));

    await post(messageFrom(ann.teams, { text: "What's on my calendar?" }));
    await post(messageFrom(ann.teams, { text: "And tomorrow?" }));

    const cards = await connectCards(ann.teams.conversation);
    expect(cards).toHaveLength(1);
    const [card = ""] = cards;
    expect(card).toContain("Connect Microsoft 365");
    // Nothing in the link binds: no id, no token, no state.
    expect(card.match(/https:[^"\\]*connect-microsoft[^"\\]*/gu)).toStrictEqual(
      [connectLink]
    );
  });

  it("carries on with what they asked once they connect their own account", async () => {
    const ann = await member(
      idp,
      says("I can't see your calendar yet."),
      says("You have the board meeting at ten.")
    );
    await post(messageFrom(ann.teams, { text: "What's on my calendar?" }));

    const response = await backFromProvider(
      ann.session,
      consented(await started(ann), oidOf(ann))
    );

    expect(response.headers.get("location")).toMatch(
      new RegExp(`^${clientOrigin}/integrations\\?connection=`, "u")
    );
    const { lines, activities } = await reached(ann.teams.conversation);
    expect(lines).toContain(
      "Your Microsoft 365 is connected. I'll carry on with what you asked."
    );
    expect(JSON.stringify(activities.at(-1))).toContain(
      "You have the board meeting at ten."
    );
    // What was asked was asked again, once.
    expect(
      ann.provider.requests.filter((request) =>
        JSON.stringify(request).includes("What's on my calendar?")
      ).length
    ).toBeGreaterThanOrEqual(2);
    // Carried on once: the same flow's callback again carries nothing on.
    const before = await reached(ann.teams.conversation);
    await backFromProvider(
      ann.session,
      consented(await started(ann), oidOf(ann))
    );
    const after = await reached(ann.teams.conversation);
    expect(after.activities).toHaveLength(before.activities.length);
  });

  it("carries nothing on when someone else finishes the flow, or the account isn't theirs", async () => {
    const ann = await member(idp, says("Not yet."), says("Never shown."));
    const mallory = await memberAnsweredBy(idp, ann.provider);
    await post(messageFrom(ann.teams, { text: "What's on my calendar?" }));
    const before = await reached(ann.teams.conversation);

    // Mallory brings Ann's flow back with her own session: connect refuses.
    const swapped = await backFromProvider(
      mallory.session,
      consented(await started(ann), oidOf(ann))
    );
    // Ann consents with an account whose object id isn't one she signs in
    // with: connect refuses it.
    const notHers = await backFromProvider(
      ann.session,
      consented(await started(ann), `oid-${crypto.randomUUID()}`)
    );

    expect([
      swapped.headers.get("location"),
      notHers.headers.get("location"),
    ]).toStrictEqual([
      `${clientOrigin}/integrations?connectionError=connection.flow_invalid`,
      `${clientOrigin}/integrations?connectionError=connection.not_own_account`,
    ]);
    const after = await reached(ann.teams.conversation);
    expect(after.activities).toHaveLength(before.activities.length);
    await expect(reached(mallory.teams.conversation)).resolves.toMatchObject({
      activities: [],
    });
  });

  it("is offered again, saying so, when their connection needs a new sign-in", async () => {
    const ann = await member(idp, says("Connected."), says("Not now."));
    await backFromProvider(
      ann.session,
      consented(await started(ann), oidOf(ann))
    );
    const [connection] = await ann.api.connections.list();
    await connectDb()
      .prepare("UPDATE connections SET status = 'needs_reauth' WHERE id = ?")
      .bind(connection?.id ?? "")
      .run();

    await post(messageFrom(ann.teams, { text: "Any new mail?" }));

    const cards = await connectCards(ann.teams.conversation);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("needs a new sign-in");
  });
});
