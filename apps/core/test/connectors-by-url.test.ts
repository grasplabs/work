import type { WaitingFeed } from "@grasp-os/shared/waiting";
import { describe, expect, it } from "vite-plus/test";

import { linearMcpUrl } from "../../connect/test/linear-mcp-fake.ts";
import type { Consent } from "../../connect/test/linear-mcp-fake.ts";
import { codeResults, codeStep, personalChatsOf, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { linearConsentUrl } from "./linear-service.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { outcome, routed, signedInApi } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// Connectors made from an MCP server's URL, through core (GRA-2331): an
// admin adds Linear's server by its URL, everyone finds it in the catalog
// by its name, a person connects it by signing in at Linear (connect's
// faithful fake, test/linear-service.ts), and their chat's agent reads
// their issues through it once they granted it. The ways it can fail,
// which the tests start from: a member adds a server; a hidden connector
// is still connected; its sign-in leaves for the relay or another origin;
// a connection whose access ran out shows nowhere, or can't be signed in
// to again.

const idp = mockIdp();

/** Signing people in and running turns can be slow on CI. */
const slow = { timeout: 90_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

let added: Promise<string> | undefined;

/**
 * Linear's server as a connector, added once a file by an admin (a
 * server is added once: connect refuses its URL again): its ID.
 */
const linear = async (): Promise<string> => {
  added ??= (async () => {
    const admin = await signedInApi(idp, "admin");
    const { id } = await admin.api.connections.addConnector({
      name: "Linear",
      url: linearMcpUrl,
      auth: { kind: "oauth" },
    });
    return id;
  })();
  return await added;
};

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The person approving the sign-in at `url`, as Linear would. */
const consentAt = async (url: string): Promise<Consent> => {
  const internet = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(internet)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await internet.fetch(linearConsentUrl, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  return await response.json<Consent>();
};

/** Linear sending `person`'s browser back to core's callback. */
const backFromLinear = async (
  person: Person,
  { code, state, iss }: Consent
): Promise<Response> =>
  await routed(
    `/api/connections/callback?${new URLSearchParams({ code, state, ...(iss === undefined ? {} : { iss }) }).toString()}`,
    { headers: { cookie: person.session } }
  );

/** Connects `person` to `connector` end to end: the connection's ID. */
const connect = async (
  person: Person,
  connector: string,
  scope: "personal" | "shared" = "personal"
): Promise<string> => {
  const { url } = await person.api.connections.start({
    provider: connector,
    scope,
    returnTo: "/connectors",
  });
  const back = await backFromLinear(person, await consentAt(url));
  const location = new URL(back.headers.get("location") ?? "");
  return location.searchParams.get("connection") ?? "";
};

describe("a connector made from a URL", slow, () => {
  it("is added by an admin, never a member, and listed by its name for everyone, offered", async () => {
    const member = await signedInApi(idp, "user");
    await expect(
      outcome(
        member.api.connections.addConnector({
          name: "Linear",
          url: linearMcpUrl,
          auth: { kind: "oauth" },
        })
      )
    ).resolves.toBe("role.forbidden");
    const id = await linear();

    const { entries } = await member.api.connections.catalog();
    expect(entries.find((entry) => entry.id === id)).toStrictEqual({
      source: "connector",
      id,
      name: "Linear",
      categories: [],
      toolCount: null,
      logo: null,
      description: null,
      group: "Other",
      auth: "managed",
      offered: true,
    });
    // Its server lists its tools only to a connection.
    await expect(
      member.api.connections.catalogTools("connector", id)
    ).resolves.toStrictEqual([]);
  });

  it("is connected by signing in at its server, which returns to this origin itself, never the relay", async () => {
    const id = await linear();
    const person = await signedInApi(idp, "user");
    const { url } = await person.api.connections.start({
      provider: id,
      scope: "personal",
      returnTo: "/connectors",
    });
    const asked = new URL(url);
    expect({
      at: `${asked.origin}${asked.pathname}`,
      redirect: asked.searchParams.get("redirect_uri"),
    }).toStrictEqual({
      at: "https://mcp.linear.app/authorize",
      redirect: `${clientOrigin}/api/connections/callback`,
    });
    const back = await backFromLinear(person, await consentAt(url));
    expect(back.status).toBe(303);
    const location = new URL(back.headers.get("location") ?? "");
    const connectionId = location.searchParams.get("connection");
    expect(`${location.origin}${location.pathname}`).toBe(
      `${clientOrigin}/connectors`
    );
    const listed = await person.api.connections.list();
    expect(
      listed
        .filter((connection) => connection.id === connectionId)
        .map(({ source, provider, scope, status, ownerUserId }) => ({
          source,
          provider,
          scope,
          status,
          ownerUserId,
        }))
    ).toStrictEqual([
      {
        source: "connector",
        provider: id,
        scope: "personal",
        status: "active",
        ownerUserId: person.userId,
      },
    ]);
  });

  it("can't be connected while an admin hides it, and is in no one's catalog but an admin's", async () => {
    const id = await linear();
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    await admin.api.connections.setOffered("connector", id, false);
    try {
      await expect(
        outcome(
          person.api.connections.start({
            provider: id,
            scope: "personal",
            returnTo: "/connectors",
          })
        )
      ).resolves.toBe("connection.not_offered");
      const seen = await person.api.connections.catalog();
      expect(seen.entries.some((entry) => entry.id === id)).toBeFalsy();
      const managed = await admin.api.connections.catalog();
      expect(
        managed.entries.find((entry) => entry.id === id)?.offered
      ).toBeFalsy();
    } finally {
      await admin.api.connections.setOffered("connector", id, true);
    }
  });

  it("waits for its person to sign in again once its access ran out, by its name, and is signed in to again in place", async () => {
    const id = await linear();
    const person = await signedInApi(idp, "user");
    const connectionId = await connect(person, id);
    // As connect leaves one once Linear refuses its refresh: its tokens gone.
    const db = connectDb();
    await db.batch([
      db
        .prepare("UPDATE connections SET status = 'needs_reauth' WHERE id = ?")
        .bind(connectionId),
      db
        .prepare("DELETE FROM connection_tokens WHERE connection_id = ?")
        .bind(connectionId),
    ]);

    const { items } = await person.api.waiting.list();
    const waiting = items.filter(
      (
        item
      ): item is Extract<
        WaitingFeed["items"][number],
        { kind: "signInAgain" }
      > => item.kind === "signInAgain" && item.connection.id === connectionId
    );
    expect(waiting.map(({ integration }) => integration)).toStrictEqual([
      { source: "connector", id, name: "Linear" },
    ]);

    await expect(connect(person, id)).resolves.toBe(connectionId);
    const listed = await person.api.connections.list();
    expect(
      listed.find((connection) => connection.id === connectionId)?.status
    ).toBe("active");
  });

  it("with a key in a header is connected with the key its person typed, which its server must take", async () => {
    const admin = await signedInApi(idp, "admin");
    // A path of Linear's origin that serves no MCP: no key works there.
    const { id } = await admin.api.connections.addConnector({
      name: "Keyed",
      url: "https://mcp.linear.app/keyed",
      auth: { kind: "header", header: "X-Api-Key" },
    });
    const { entries } = await admin.api.connections.catalog();
    expect(entries.find((entry) => entry.id === id)?.auth).toBe("key");
    const person = await signedInApi(idp, "user");
    await expect(
      outcome(
        person.api.connections.connectWithKey({
          provider: id,
          scope: "personal",
          key: "lin-key-0001",
          returnTo: "/connectors",
        })
      )
    ).resolves.toBe("connection.provider_refused");
    const listed = await person.api.connections.list();
    expect(listed.some((connection) => connection.provider === id)).toBeFalsy();
  });

  it("is used by its person's chat once they granted their chat their connection", async () => {
    const id = await linear();
    const person = await signedInApi(idp, "user");
    const connectionId = await connect(person, id);
    const chats = await personalChatsOf(
      person.userId,
      codeStep(
        `export default async (self, env) => { const offered = (await env.connections.available()).find((each) => each.connectionId === ${JSON.stringify(connectionId)}); return await env.connections.request({ connectionId: offered.connectionId, actions: offered.actions.filter((action) => action === "list_issues"), binding: "LINEAR", reason: "To find your open issues." }); };`
      ),
      says("It waits for you."),
      codeStep(
        'export default async (self, env) => { const { output } = await env.connections.call("LINEAR", "list_issues", { limit: 1 }); return output; };'
      ),
      says("Found them.")
    );
    const chat = await chats.newChat();
    await chat.ask("Which issues are open in Linear?");
    const [request] = await person.api.chats.connectionRequests(chat.chat.id);
    expect(request?.provider).toBe(id);
    await person.api.chats.grantConnection(chat.chat.id, request?.id ?? "");
    await chat.ask("Now look.");

    const steps = await codeResults(chats.stub, chat.chat.id);
    const [, called] = steps.map(({ text }) => text);
    // Linear's own words for its first issue, as its server answered them.
    expect(called).toContain("ENG-");
  });
});
