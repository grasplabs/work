import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { env, exports } from "cloudflare:workers";
import { and, eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { adminMcp, servedTools } from "../src/admin/mcp.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  clients,
  rollouts,
  rolloutTargets,
} from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { accessJwt, mockAccess } from "./access.ts";
import { emptyAdminSnapshot, mockCloudflareApi } from "./cloudflare-api.ts";
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// The admin's MCP (GRA-656), from its threat model: only a staff member
// Access vouches for reaches it, and only from an MCP client, never a page
// elsewhere riding their cookie; listing reads nothing; a call reads every
// client once, is audited before it reads, and is limited per person; a
// tool only reads, and its numbers are the pages'.

const token = "test-deployer-token-admin-mcp-4e19a7";
const tenantToken = "test-tenant-admin-token-admin-mcp-b20c63";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);
const origin = "https://console.grasp.test";
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await publishRelease({ notes: "feat(core): the admin" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const account = cloudflare.addAccount(`Acme ${clientId}`);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Acme ${clientId}`,
        accountId: account.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, release.id)
  );
  return { clientId, name: `Acme ${clientId}`, account };
};

/**
 * A company of which 85% is known, past the 80% it opens at, with
 * nothing signed yet: three things need Grasp (the go and both
 * agreements), as the overview page shows it.
 */
const readySnapshot = (name: string): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  return {
    ...empty,
    kickoff: { at: empty.now, known: 0.5 },
    gate: { ...empty.gate, known: 85, ready: true },
  };
};

/** A JSON-RPC request of the MCP, as a client sends it. */
const rpc = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});

/** POSTs `body` to the console's /mcp with `headers`, as an MCP client would. */
const post = async (
  body: unknown,
  headers: Record<string, string>
): Promise<Response> =>
  await exports.default.fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** A JSON-RPC answer, as far as the tests read it. */
const answerSchema = z.object({
  result: z
    .object({
      serverInfo: z.object({ name: z.string() }).optional(),
      instructions: z.string().optional(),
      tools: z
        .array(
          z.object({
            name: z.string(),
            annotations: z.object({
              readOnlyHint: z.boolean(),
              destructiveHint: z.boolean(),
            }),
          })
        )
        .optional(),
      content: z.array(z.object({ text: z.string() })).optional(),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
});

/** Organizations as `list_organizations` gives them. */
const listedSchema = z.object({
  organizations: z.array(
    z.object({ id: z.string(), known: z.number(), needs: z.number() }).loose()
  ),
});

/** What a staff member's MCP client gets for `body`: the JSON-RPC result. */
const asStaff = async (body: unknown, email = staff.email) => {
  const response = await post(body, {
    "cf-access-jwt-assertion": await accessJwt(email),
  });
  const answer = answerSchema.parse(await response.json());
  return { status: response.status, answer };
};

/** The audit log's `admin.mcp.call` events. */
const mcpCalls = async () => {
  const rows = await db
    .select({
      actor: auditEvents.actor,
      target: auditEvents.target,
      detail: auditEvents.detail,
    })
    .from(auditEvents)
    .where(eq(auditEvents.action, "admin.mcp.call"));
  return rows.map(({ actor, target, detail }) => ({
    actor,
    target,
    detail: detail === null ? null : z.unknown().parse(JSON.parse(detail)),
  }));
};

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

describe("the admin's MCP", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  // Only each test's own clients are read, and only its own calls audited.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
    await db
      .delete(auditEvents)
      .where(and(eq(auditEvents.action, "admin.mcp.call")));
  });

  it("gives nothing to a request Access doesn't vouch for, nor to a page elsewhere riding a staff member's cookie, reading no core", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");
    const call = rpc("tools/call", {
      name: "list_organizations",
      arguments: {},
    });
    const statusOf = async (headers: Record<string, string>) => {
      const response = await post(call, headers);
      return response.status;
    };
    const jwt = async (claims: Parameters<typeof accessJwt>[1]) =>
      await accessJwt(staff.email, claims);

    expect({
      none: await statusOf({}),
      otherApplication: await statusOf({
        "cf-access-jwt-assertion": await jwt({
          claims: { aud: ["another-app"] },
        }),
      }),
      otherTeam: await statusOf({
        "cf-access-jwt-assertion": await jwt({
          claims: { iss: "https://elsewhere.cloudflareaccess.com" },
        }),
      }),
      expired: await statusOf({
        "cf-access-jwt-assertion": await jwt({ expiresIn: -60 }),
      }),
      forged: await statusOf({
        "cf-access-jwt-assertion": await jwt({ stranger: true }),
      }),
      // A service token names no person.
      serviceToken: await statusOf({
        "cf-access-jwt-assertion": await jwt({ claims: { email: "" } }),
      }),
      // A browser sends Origin on every POST; a page elsewhere can't call.
      crossSite: await statusOf({
        "cf-access-jwt-assertion": await accessJwt(staff.email),
        origin: "https://attacker.example",
      }),
      readers: acme.account.adminReaders,
      audited: await mcpCalls(),
    }).toStrictEqual({
      none: 403,
      otherApplication: 403,
      otherTeam: 403,
      expired: 403,
      forged: 403,
      serviceToken: 403,
      crossSite: 403,
      readers: [],
      audited: [],
    });
  });

  it("lists the admin's tools the console can feed, each read-only, reading nothing", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");

    const initialized = await asStaff(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      })
    );
    const listed = await asStaff(rpc("tools/list"));
    const tools = listed.answer.result?.tools ?? [];

    expect({
      initialized: {
        status: initialized.status,
        server: initialized.answer.result?.serverInfo?.name,
        instructions: typeof initialized.answer.result?.instructions,
      },
      status: listed.status,
      tools: tools.map(({ name }) => name),
      readOnly: tools.every(
        ({ annotations }) =>
          annotations.readOnlyHint && !annotations.destructiveHint
      ),
      readers: acme.account.adminReaders,
      audited: await mcpCalls(),
    }).toStrictEqual({
      initialized: {
        status: 200,
        server: "grasp-admin",
        instructions: "string",
      },
      status: 200,
      tools: servedTools.map(({ name }) => name),
      readOnly: true,
      readers: [],
      audited: [],
    });
  });

  it("answers a call with the numbers the overview shows, reading every client once as the caller, audited before it reads", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");
    const down = await liveClient();
    down.account.unhealthy = 1000;

    const listed = await asStaff(
      rpc("tools/call", { name: "list_organizations", arguments: {} })
    );
    const one = await asStaff(
      rpc("tools/call", {
        name: "get_organization",
        arguments: { organization: acme.clientId },
      })
    );
    const { html } = await page("/admin", staff.email);

    const { organizations } = listedSchema.parse(
      listed.answer.result?.structuredContent
    );
    const text = one.answer.result?.content?.[0]?.text;
    expect({
      status: listed.status,
      // Only a client whose core answered has numbers: the one down has none.
      organizations,
      // The overview says the same of Acme.
      page: [
        "85% known. Ready for Grasp’s go",
        'text-status-attention tabular-nums">3<',
      ].map((shown) => html.includes(shown)),
      oneSaysKnown: text?.includes("85%"),
      oneFailed: one.answer.result?.isError,
      // Each call read Acme's core once, as the caller; the page once more.
      readers: acme.account.adminReaders,
      audited: await mcpCalls(),
    }).toStrictEqual({
      status: 200,
      organizations: [
        expect.objectContaining({ id: acme.clientId, known: 85, needs: 3 }),
      ],
      page: [true, true],
      oneSaysKnown: true,
      oneFailed: undefined,
      readers: [staff.email, staff.email, staff.email],
      audited: [
        { actor: staff.email, target: "list_organizations", detail: {} },
        {
          actor: staff.email,
          target: "get_organization",
          detail: { organization: acme.clientId },
        },
      ],
    });
  });

  it("refuses arguments off a tool's schema, and a tool it doesn't have, reading nothing", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");

    const answers = await Promise.all(
      [
        { name: "compare_organizations", arguments: { measure: "salary" } },
        { name: "get_organization", arguments: {} },
        { name: "list_organizations", arguments: { phase: "open", drop: 1 } },
        { name: "delete_organization", arguments: {} },
        // Nothing records integrations to build yet (GRA-689): not served.
        { name: "integrations_to_build", arguments: {} },
      ].map(async (params) => {
        const { answer } = await asStaff(rpc("tools/call", params));
        return answer.result?.isError;
      })
    );

    expect({
      answers,
      readers: acme.account.adminReaders,
      audited: await mcpCalls(),
    }).toStrictEqual({
      answers: [true, true, true, true, true],
      readers: [],
      audited: [],
    });
  });

  it("limits each staff member's calls, the one over the limit a 429 that reads nothing", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");
    const limited = { ...env, ADMIN_MCP_RATE_LIMIT: limiterAllowing(1) };
    const call = () =>
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(
          rpc("tools/call", { name: "daily_digest", arguments: {} })
        ),
      });
    const listing = () =>
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(rpc("tools/list")),
      });

    const first = await adminMcp(call(), staff, limited);
    const second = await adminMcp(call(), staff, limited);
    const listed = await adminMcp(listing(), staff, limited);
    const audited = await mcpCalls();

    expect({
      first: first.status,
      second: second.status,
      retryAfter: second.headers.get("retry-after"),
      // Listing reads nothing, so it isn't limited beyond Access.
      listed: listed.status,
      readers: acme.account.adminReaders,
      audited: audited.length,
    }).toStrictEqual({
      first: 200,
      second: 429,
      retryAfter: "60",
      listed: 200,
      readers: [staff.email],
      audited: 1,
    });
  });

  it("refuses a batch of calls, which would run several under one of the limit's counts, reading nothing", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");
    const batch = [1, 2, 3].map((id) => ({
      ...rpc("tools/call", { name: "daily_digest", arguments: {} }),
      id,
    }));
    const response = await post(batch, {
      "cf-access-jwt-assertion": await accessJwt(staff.email),
    });
    expect({
      status: response.status,
      readers: acme.account.adminReaders,
      audited: await mcpCalls(),
    }).toStrictEqual({ status: 400, readers: [], audited: [] });
  });

  it("names no person and gives a company's names only as data", async () => {
    const acme = await liveClient();
    acme.account.admin = readySnapshot("Acme");
    const { answer } = await asStaff(
      rpc("tools/call", {
        name: "get_organization",
        arguments: { organization: acme.clientId },
      })
    );
    const text = answer.result?.content?.[0]?.text ?? "";
    const names = z
      .object({
        organizations: z.array(z.object({ id: z.string(), name: z.string() })),
      })
      .parse(answer.result?.structuredContent?.names);
    expect({
      nameInText: text.includes("Acme"),
      idInText: text.includes(acme.clientId),
      names: names.organizations,
    }).toStrictEqual({
      nameInText: false,
      idInText: true,
      names: [{ id: acme.clientId, name: "Acme" }],
    });
  });

  it("answers every company's platform as the Platform page shows it, by id, reading no core", async () => {
    const [oldest, older, newest] = [
      await publishRelease({ notes: "feat(core): the oldest" }),
      await publishRelease({ notes: "feat(core): the older" }),
      await publishRelease({ notes: "feat(core): the newest" }),
    ];
    await importReleases(env.RELEASES, db);
    const ringClient = async (
      name: string,
      ring: number,
      releaseId: string
    ) => {
      const clientId = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
      const account = cloudflare.addAccount(name);
      account.admin = readySnapshot(name);
      const now = new Date();
      await act(
        db,
        staff,
        [
          db.insert(clients).values({
            id: clientId,
            name,
            accountId: account.id,
            ring,
            status: "active",
            createdAt: now,
            updatedAt: now,
          }),
        ],
        { action: "client.create", clientId }
      );
      await runDeploy(
        await deployContext(env),
        await startDeploy(db, staff, clientId, releaseId)
      );
      return { clientId, account };
    };
    const first = await ringClient("Firstco", 0, newest.id);
    const early = await ringClient("Earlyco", 1, older.id);
    const laggard = await ringClient("Laggard", 2, oldest.id);
    const rolloutId = crypto.randomUUID();
    const now = new Date();
    await db.insert(rollouts).values({
      id: rolloutId,
      kind: "release",
      releaseId: newest.id,
      status: "waiting",
      ring: 0,
      startedBy: staff.email,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(rolloutTargets).values([
      {
        rolloutId,
        clientId: first.clientId,
        ring: 0,
        status: "done",
        updatedAt: now,
      },
      {
        rolloutId,
        clientId: early.clientId,
        ring: 1,
        status: "pending",
        updatedAt: now,
      },
    ]);

    const { answer } = await asStaff(
      rpc("tools/call", { name: "platforms", arguments: {} })
    );
    // Before the page, whose frame reads every core for its sidebar.
    const readers = [first, early, laggard].flatMap(
      ({ account }) => account.adminReaders
    );
    const { html } = await page("/admin/platform", staff.email);
    const text = answer.result?.content?.[0]?.text ?? "";
    const { platforms, names } = z
      .object({
        platforms: z.array(
          z.object({
            organization: z.string(),
            standing: z.string(),
            needs: z.array(z.string()),
          })
        ),
        names: z.object({
          organizations: z.array(
            z.object({ id: z.string(), name: z.string() })
          ),
        }),
      })
      .parse(answer.result?.structuredContent);

    expect({
      // The one that needs a look first, as the page lists it.
      platforms: platforms.map(({ organization, standing, needs }) => ({
        organization,
        standing,
        needs,
      }))[0],
      pageSaysBehind: html.includes("2 releases behind the newest."),
      laggardLine: text.includes(
        `- ${laggard.clientId}: attention; ring 2; runs ${oldest.id};`
      ),
      behind: text.includes("2 releases behind"),
      goingOut: text.includes(`Going out now: ${newest.id}, waiting`),
      ring0: text.includes("Ring 0: 1 of 1 on it (done)"),
      // A company's name only as data.
      namesInText: ["Firstco", "Earlyco", "Laggard"].some((name) =>
        text.includes(name)
      ),
      named: names.organizations.filter(({ id }) =>
        [first.clientId, early.clientId, laggard.clientId].includes(id)
      ).length,
      // No core was asked: the console's records and the accounts' live columns only.
      readers,
      audited: await mcpCalls(),
    }).toStrictEqual({
      platforms: {
        organization: laggard.clientId,
        standing: "attention",
        needs: ["behind"],
      },
      pageSaysBehind: true,
      laggardLine: true,
      behind: true,
      goingOut: true,
      ring0: true,
      namesInText: false,
      named: 3,
      readers: [],
      audited: [{ actor: staff.email, target: "platforms", detail: {} }],
    });
  });

  it("serves no standing stream or session: only POST", async () => {
    const jwt = await accessJwt(staff.email);
    const statuses = await Promise.all(
      ["GET", "DELETE"].map(async (method) => {
        const response = await exports.default.fetch(`${origin}/mcp`, {
          method,
          headers: { "cf-access-jwt-assertion": jwt },
        });
        return response.status;
      })
    );
    // A DELETE has no Origin either, but isn't a call: the console's rule
    // for a non-GET request without its Origin refuses it.
    expect(statuses).toStrictEqual([405, 403]);
  });
});
