import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { fromHex, toHex } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { discordApi, discordInteraction } from "../src/admin/discord.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { discordTest } from "./discord-config.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";
import { longStream } from "./streamed-body.ts";

// Grasp's Discord bot (GRA-663, on the Chat SDK since GRA-1060), from its
// threat model: only what Discord's signature vouches for gets past the
// route outside Access; only Grasp's staff get an answer, the rest a refusal
// only they see that reads nothing; a question is audited before it reads,
// limited per Discord user, and answered from the admin's tools without a
// person's name, interview text or a team's name.

const token = "test-deployer-token-discord-6c2f91";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** The answers the bot sent through Discord's interaction webhooks, in this test. */
const sent: { url: string; method: string; body: unknown }[] = [];

/**
 * Stands in for Discord's API for each test, after the fake Cloudflare API
 * and Access: the rest goes on to them.
 */
const mockDiscord = () => {
  beforeEach(() => {
    sent.length = 0;
    const earlier = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith(`${discordApi}/`)) {
        sent.push({
          url: request.url,
          method: request.method,
          body: await request.json(),
        });
        return Response.json({ id: "1" });
      }
      if (earlier === undefined) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return await earlier(input, init);
    });
  });
};

const db = adminDatabase(env.DB);
const origin = "https://ops.grasp.test";
const [staffId, otherStaffId] = discordTest.staffIds;
const strangerId = "333333333333333333";

/** The key Discord's stand-in signs with: the test application's. */
const signingKey = await crypto.subtle.importKey(
  "pkcs8",
  fromHex(`302e020100300506032b657004220420${discordTest.signingSeed}`) ??
    new Uint8Array(),
  { name: "Ed25519" },
  false,
  ["sign"]
);
/** A key Discord never had: what anyone else could sign with. */
const strangerKey = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  false,
  ["sign", "verify"]
);

const encoder = new TextEncoder();

interface Signing {
  key?: CryptoKey;
  /** Seconds since the epoch the request says it was signed at. */
  at?: number;
  /** A body other than the one signed, as one changed on its way. */
  sentBody?: string;
}

/** A request as Discord posts it to the bot: `body` signed with its timestamp. */
const signed = async (
  body: unknown,
  {
    key = signingKey,
    at = Math.floor(Date.now() / 1000),
    sentBody,
  }: Signing = {}
): Promise<Request> => {
  const text = JSON.stringify(body);
  const timestamp = String(at);
  const signature = toHex(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        key,
        encoder.encode(`${timestamp}${text}`)
      )
    )
  );
  return new Request(`${origin}/discord/interactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body: sentBody ?? text,
  });
};

const ping = { type: 1, id: "1", application_id: "999", token: "ping-token" };

/** `/grasp <sub>` with `options`, as `user` asks it in Grasp's server. */
const command = (
  user: string,
  sub: string,
  options: { name: string; type: number; value: string }[] = []
) => ({
  type: 2,
  id: "2",
  application_id: "999",
  token: `token-${crypto.randomUUID()}`,
  guild_id: "444444444444444444",
  channel_id: "555555555555555555",
  member: { user: { id: user, username: "staff" } },
  data: { name: "grasp", options: [{ name: sub, type: 1, options }] },
});

const replySchema = z.object({
  type: z.number(),
  data: z
    .object({ content: z.string().optional(), flags: z.number().optional() })
    .optional(),
});

/** What the bot answers `request` with, after anything it sends later is sent. */
const ask = async (
  request: Request,
  environment: Env = env
): Promise<{ status: number; reply: unknown; later: string[] }> => {
  const waits: Promise<unknown>[] = [];
  const response = await discordInteraction(request, environment, (promise) => {
    waits.push(promise);
  });
  await Promise.all(waits);
  const reply: unknown =
    response.headers.get("content-type")?.includes("json") === true
      ? await response.json()
      : await response.text();
  const later = sent.map(
    ({ body }) => z.object({ content: z.string() }).parse(body).content
  );
  return { status: response.status, reply, later };
};

/** The audit log's `admin.discord.call` events. */
const discordCalls = async () =>
  await db
    .select({
      actor: auditEvents.actor,
      target: auditEvents.target,
      detail: auditEvents.detail,
    })
    .from(auditEvents)
    .where(eq(auditEvents.action, "admin.discord.call"));

/** A stand-in for Cloudflare's rate limiter that lets `allowed` calls through. */
const limiterAllowing = (allowed: number): RateLimit => {
  let left = allowed;
  return {
    limit: async () => {
      left -= 1;
      return await Promise.resolve({ success: left >= 0 });
    },
  };
};

/** An active client running a new release, as a deploy made it live. */
const liveClient = async (name: string) => {
  const release = await placedRelease("feat(core): the admin");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name,
    signIn: null,
  });
  return { clientId, account };
};

/**
 * A company of which 85% is known, past the 80% it opens at, with nothing
 * signed yet: three things need Grasp (the go and both agreements).
 */
const readySnapshot = (name: string): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  return {
    ...empty,
    kickoff: { at: empty.now, known: 0.5 },
    gate: { ...empty.gate, known: 85, ready: true },
  };
};

/** A person's and a team's name no answer may carry. */
const leadName = "Lisa Vermeulen";
const teamName = "Benelux Sales";
/** Where the answer to the test's interaction goes: its webhook's first message. */
const webhookUrl =
  /^https:\/\/discord\.com\/api\/v10\/webhooks\/999\/token-[\w-]+\/messages\/@original$/u;
/** Any part of them. */
const names = /Lisa|Vermeulen|Tom|Boer|Benelux|Sales/u;

/**
 * A company told three days ago, on a plan of fourteen days, whose one
 * team's lead hasn't talked: a lead Grasp waits on, with a name.
 */
const waitingOnLead = (name: string): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  const told = new Date(Date.parse(empty.now) - 3 * 86_400_000).toISOString();
  return {
    ...empty,
    kickoff: { at: told, known: 0.5 },
    roster: {
      teams: [
        { id: "sales", name: teamName, lead: "lisa", does: "", off: false },
      ],
      people: [
        ["lisa", leadName],
        ["tom", "Tom de Boer"],
      ].map(([id = "", person = ""]) => ({
        id,
        name: person,
        email: "",
        team: "sales",
        title: "",
        away: false,
      })),
    },
    plan: { start: told.slice(0, 10), days: 14, at: told },
    agreements: { processing: true, assessment: true, council: "none" },
    agreed: true,
    told: true,
    // The lead's link went out and they were reminded; the team's waits
    // on them.
    links: [
      {
        person: "lisa",
        sentAt: told,
        openedAt: null,
        remindedAt: told,
        deletedAt: null,
        failedMail: null,
        state: "waiting",
      },
      {
        person: "tom",
        sentAt: null,
        openedAt: null,
        remindedAt: null,
        deletedAt: null,
        failedMail: null,
        state: "waiting",
      },
    ],
  };
};

/** What the admin's own route answers `request` with. */
const routed = async (request: Request) => {
  const response = await exports.default.fetch(request);
  return { status: response.status, body: await response.text() };
};

/** The first answer the bot sent later, or none. */
const firstOf = (later: readonly string[]): string => later[0] ?? "";

describe("Grasp's Discord bot", () => {
  useStoreSecrets({ deployer: token });
  mockDiscord();
  // Only each test's own clients are read, and only its own calls audited.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
    await db
      .delete(auditEvents)
      .where(eq(auditEvents.action, "admin.discord.call"));
  });

  it("answers Discord's signed PING outside Access, and refuses anything Discord didn't sign", async () => {
    const otherKey = await routed(
      await signed(ping, { key: strangerKey.privateKey })
    );
    const changedOnItsWay = await routed(
      await signed(ping, {
        sentBody: JSON.stringify({ ...ping, token: "other" }),
      })
    );
    const stale = await routed(
      await signed(ping, { at: Math.floor(Date.now() / 1000) - 600 })
    );

    expect({
      ping: await routed(await signed(ping)),
      unsigned: await routed(
        new Request(`${origin}/discord/interactions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ping),
        })
      ),
      otherKey: otherKey.status,
      changedOnItsWay: changedOnItsWay.status,
      stale: stale.status,
    }).toStrictEqual({
      ping: { status: 200, body: JSON.stringify({ type: 1 }) },
      unsigned: { status: 401, body: "Invalid request signature." },
      otherKey: 401,
      changedOnItsWay: 401,
      stale: 401,
    });
  });

  it("refuses a body past its limit without holding it, though it declares no length, auditing nothing", async () => {
    // Far longer than an interaction may be, with no Content-Length: only
    // as much of it is pulled as it takes to see it is too long.
    const { body, heldWhole } = longStream();
    const { status } = await routed(
      new Request(`${origin}/discord/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );

    expect({
      status,
      heldWhole: heldWhole(),
      audited: await discordCalls(),
    }).toStrictEqual({ status: 413, heldWhole: false, audited: [] });
  });

  it("takes a request signed with the application's public key however its setting is spaced", async () => {
    const { status } = await ask(await signed(ping), {
      ...env,
      DISCORD_PUBLIC_KEY: ` ${env.DISCORD_PUBLIC_KEY ?? ""}\n`,
    });

    expect(status).toBe(200);
  });

  it("refuses everything without the application's public key", async () => {
    const { status } = await ask(await signed(ping), {
      ...env,
      DISCORD_PUBLIC_KEY: "",
    });

    expect(status).toBe(401);
  });

  it("gives someone who isn't staff a refusal only they see, reading and auditing nothing", async () => {
    const acme = await liveClient("Acme");
    acme.account.admin = readySnapshot("Acme");

    const { status, reply, later } = await ask(
      await signed(command(strangerId, "orgs"))
    );

    expect({
      status,
      reply: replySchema.parse(reply),
      later,
      readers: acme.account.adminReaders,
      audited: await discordCalls(),
    }).toStrictEqual({
      status: 200,
      reply: { type: 5, data: { flags: 64 } },
      later: ["Only Grasp's staff can ask Grasp here."],
      readers: [],
      audited: [],
    });
  });

  it("lists every company for /grasp orgs, as the asker, audited before it reads", async () => {
    const acme = await liveClient("Acme");
    acme.account.admin = readySnapshot("Acme");
    const globex = await liveClient("Globex");
    globex.account.admin = waitingOnLead("Globex");

    const { status, reply, later } = await ask(
      await signed(command(staffId, "orgs"))
    );

    expect({
      status,
      reply: replySchema.parse(reply),
      readers: [...acme.account.adminReaders, ...globex.account.adminReaders],
      audited: await discordCalls(),
    }).toStrictEqual({
      status: 200,
      reply: { type: 5, data: { flags: 64 } },
      readers: [
        `discord-${staffId}@grasp.test`,
        `discord-${staffId}@grasp.test`,
      ],
      audited: [{ actor: `discord:${staffId}`, target: "orgs", detail: "{}" }],
    });
    expect({
      answers: later.length,
      lines: firstOf(later).split("\n").toSorted(),
      toWebhook: webhookUrl.test(sent[0]?.url ?? ""),
      method: sent[0]?.method,
      body: sent[0]?.body,
    }).toStrictEqual({
      answers: 1,
      lines: [
        `- **Acme** (\`${acme.clientId}\`): ready for Grasp's go; 85% known; 3 things need Grasp`,
        `- **Globex** (\`${globex.clientId}\`): interviews; 0% known; 1 thing needs Grasp`,
        "2 companies:",
      ],
      toWebhook: true,
      method: "PATCH",
      body: {
        content: firstOf(later),
        allowed_mentions: { parse: [] },
        flags: 64,
      },
    });
  });

  it("narrows /grasp orgs to a phase", async () => {
    const acme = await liveClient("Acme");
    acme.account.admin = readySnapshot("Acme");
    const globex = await liveClient("Globex");
    globex.account.admin = waitingOnLead("Globex");

    const { later } = await ask(
      await signed(
        command(staffId, "orgs", [{ name: "phase", type: 3, value: "ready" }])
      )
    );

    expect(later).toStrictEqual([
      `1 company:\n- **Acme** (\`${acme.clientId}\`): ready for Grasp's go; 85% known; 3 things need Grasp`,
    ]);
  });

  it("tells one company for /grasp org, with what needs Grasp there in fixed words, never a person's or a team's name", async () => {
    const globex = await liveClient("Globex");
    globex.account.admin = waitingOnLead("Globex");
    const acme = await liveClient("Acme");
    acme.account.admin = readySnapshot("Acme");

    const { later } = await ask(
      await signed(
        command(otherStaffId, "org", [{ name: "name", type: 3, value: "glob" }])
      )
    );

    expect({
      later,
      audited: await discordCalls(),
    }).toStrictEqual({
      later: [
        `- **Globex** (\`${globex.clientId}\`): interviews; 0% known; 1 thing needs Grasp\n  - a team lead who hasn't talked yet`,
      ],
      audited: [
        {
          actor: `discord:${otherStaffId}`,
          target: "org",
          detail: JSON.stringify({ organization: "glob" }),
        },
      ],
    });
    expect(firstOf(later)).not.toMatch(names);
  });

  it("says when no single company fits /grasp org, naming none", async () => {
    const acme = await liveClient("Acme");
    acme.account.admin = readySnapshot("Acme");

    const { later } = await ask(
      await signed(
        command(staffId, "org", [{ name: "name", type: 3, value: "Initech" }])
      )
    );

    expect(later).toStrictEqual([
      "No single company fits that. `/grasp orgs` lists them, with their ids.",
    ]);
  });

  it("lists what needs Grasp for /grasp needs, by company, in fixed words", async () => {
    const acme = await liveClient("Acme");
    acme.account.admin = readySnapshot("Acme");
    const globex = await liveClient("Globex");
    globex.account.admin = waitingOnLead("Globex");

    const { later } = await ask(await signed(command(staffId, "needs")));

    expect({
      later,
      audited: await discordCalls(),
    }).toStrictEqual({
      later: [
        [
          "4 things need Grasp:",
          `- **Acme** (\`${acme.clientId}\`)`,
          "  - ready for Grasp's go",
          "  - an agreement not signed",
          "  - an agreement not signed",
          `- **Globex** (\`${globex.clientId}\`)`,
          "  - a team lead who hasn't talked yet",
        ].join("\n"),
      ],
      audited: [{ actor: `discord:${staffId}`, target: "needs", detail: "{}" }],
    });
    expect(firstOf(later)).not.toMatch(names);
  });

  it("shows a company's name as plain text, pinging nobody", async () => {
    const sneaky = await liveClient("@everyone *Acme*");
    sneaky.account.admin = readySnapshot("@everyone *Acme*");

    const { later } = await ask(await signed(command(staffId, "orgs")));

    expect(firstOf(later)).toContain(String.raw`**\@everyone \*Acme\***`);
  });

  it("limits each Discord user's questions, reading and auditing nothing over the limit", async () => {
    const acme = await liveClient("Acme");
    acme.account.admin = readySnapshot("Acme");
    const limited = { ...env, DISCORD_RATE_LIMIT: limiterAllowing(1) };

    const first = await ask(await signed(command(staffId, "needs")), limited);
    sent.length = 0;
    const readsBefore = acme.account.adminReaders.length;
    const second = await ask(await signed(command(staffId, "needs")), limited);
    const audited = await discordCalls();

    expect({
      first: replySchema.parse(first.reply).type,
      second: replySchema.parse(second.reply),
      later: second.later,
      readsAfter: acme.account.adminReaders.length - readsBefore,
      audited: audited.length,
    }).toStrictEqual({
      first: 5,
      second: { type: 5, data: { flags: 64 } },
      later: ["Too many questions: wait a minute and ask again."],
      readsAfter: 0,
      audited: 1,
    });
  });
});
