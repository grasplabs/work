import {
  composioConsentText,
  composioToolName,
  composioToolsSchema,
  connectionErrors,
} from "@grasp-os/shared/connect";
import type { OrganizationConnection } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { forgetComposioCatalog } from "../src/catalog.ts";
import {
  changeToolkitTools,
  reconcileUnsyncedTools,
} from "../src/composio-connections.ts";
import { sessionUrlBase } from "./composio-api.ts";
import type { FakeAccount } from "./composio-api.ts";
import {
  afterMinutes,
  allowed,
  asTimePasses,
  back,
  call,
  change,
  cleanupsLeft,
  composio,
  composioWrites,
  connectHubSpot,
  contacts,
  events,
  expireFlowsOf,
  flowsOf,
  heldAtComposio,
  namesIn,
  nothingHeld,
  outOfSync,
  sessionTools,
  shownTools,
  start,
  stored,
  toolsNow,
  updates,
  withTrigger,
} from "./composio-connections-harness.ts";
import type { Start } from "./composio-connections-harness.ts";
import {
  addConnection,
  agentFor,
  callAs,
  clientOrigin,
  connectWith,
  outcome,
  runMaintenance,
  someone,
} from "./connect.ts";

// Connecting a Composio toolkit: an admin consents to Composio holding its
// tokens, connects at Composio's auth link, and comes back with one shared
// connection, to an MCP server Composio made for that toolkit's auth
// config, that one account and only the tools the admin allowed. Calls on
// it reach only those tools, with connect's key; its consent is in the
// audit log with who gave it; and whatever didn't finish is deleted at
// Composio again.

/** How each connect of the test ended, as the audit log has it. */
const connectsEnded = async () => {
  const recorded = await events();
  return recorded
    .filter(({ action }) => action === "connection.connect")
    .map(({ detail }) => [detail.outcome, detail.reason ?? null]);
};

/**
 * The code a finish ended with and why, as core's callback reads them:
 * the refusal's `details.reason`.
 */
const endingOf = async (
  promise: Promise<unknown>
): Promise<[string, unknown]> => {
  try {
    await promise;
    return ["ok", null];
  } catch (error) {
    const details: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "details")
        : undefined;
    return [
      connectionErrors.codeOf(error) ?? String(error),
      typeof details === "object" && details !== null
        ? (Reflect.get(details, "reason") ?? null)
        : null,
    ];
  }
};

describe("connecting a Composio toolkit", () => {
  it("keeps no flow of someone whose erasure began as they connected, and deletes what it made at Composio", async () => {
    const admin = someone("admin");
    // Their erasure began (person-erasure.ts marks it first) while the
    // start was under way at Composio.
    await env.DB.prepare(
      "INSERT INTO erased_people (user_id, began_at) VALUES (?, ?)"
    )
      .bind(admin.userId, Date.now())
      .run();

    const started = await outcome(start(admin));

    const flows = await env.DB.prepare(
      "SELECT count(*) AS n FROM composio_flows WHERE user_id = ?"
    )
      .bind(admin.userId)
      .first<{ n: number }>();
    // Nothing is lost on the way: what it made is gone at Composio, or
    // its cleanup row is still there to delete it.
    expect({
      started,
      flows: flows?.n,
      gone:
        JSON.stringify(heldAtComposio()) === JSON.stringify(nothingHeld) ||
        (await cleanupsLeft()) > 0,
    }).toStrictEqual({
      started: "connection.flow_invalid",
      flows: 0,
      gone: true,
    });
  });

  it("hands the unfinished flows of someone erased over to their cleanup, never just deletes them", async () => {
    const admin = someone("admin");
    await start(admin);

    await exports.default.erasePersonal({ ownerUserId: admin.userId });

    const flows = await env.DB.prepare(
      "SELECT count(*) AS n FROM composio_flows WHERE user_id = ?"
    )
      .bind(admin.userId)
      .first<{ n: number }>();
    expect({ flows: flows?.n, cleanups: await cleanupsLeft() }).toStrictEqual({
      flows: 0,
      cleanups: 1,
    });
  });

  it("sends the admin to Composio's auth link, to come back to this deployment's callback", async () => {
    const admin = someone("admin");
    const url = await start(admin);
    const [account] = composio.state.holds.accounts.values();
    const callback = new URL(account?.callbackUrl ?? "");
    expect(url).toBe(account?.redirectUrl);
    expect(`${callback.origin}${callback.pathname}`).toBe(
      `${clientOrigin}/api/connections/callback`
    );
    // This deployment's one Composio user, and Composio's own app.
    expect(account?.userId).toBe(new URL(clientOrigin).host);
    expect(
      [...composio.state.holds.authConfigs.values()].map(
        ({ toolkit, managed, name }) => ({
          toolkit,
          managed,
          // Named by the flow's marker, so it can be found without its ID.
          marked: /^grasp-[0-9a-f]{24}$/u.test(name ?? ""),
        })
      )
    ).toStrictEqual([{ toolkit: "hubspot", managed: true, marked: true }]);
  });

  it("makes one shared connection, served by a session pinned to its one account of this deployment's user, with only the allowed tools and none of Composio's own", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const { sessions, accounts } = composio.state.holds;
    const [sessionId = ""] = sessions.keys();
    const [accountId = ""] = accounts.keys();
    const session = sessions.get(sessionId);
    const account = accounts.get(accountId);
    await expect(stored(connectionId)).resolves.toStrictEqual({
      provider: "hubspot",
      scope: "shared",
      serverKind: "composio",
      server: `https://backend.composio.dev/api/v3/tool_router/session/${sessionId}/mcp`,
      accountId,
      sessionId,
      tools: JSON.stringify(allowed),
    });
    expect(session).toMatchObject({
      userId: new URL(clientOrigin).host,
      toolkits: ["hubspot"],
      authConfigs: { hubspot: account?.authConfigId },
      connectedAccounts: { hubspot: [accountId] },
      allowedTools: allowed,
      body: {
        manage_connections: { enable: false },
        workbench: { enable: false },
        proxy_execute: { enable: false },
        multi_account: { enable: false },
        instant: false,
        preload: { tools: "all" },
        search: { enable: false },
        execute: { enable_multi_execute: false },
      },
    });
    const listed = await exports.default.listConnections(someone());
    expect(listed.find(({ id }) => id === connectionId)).toMatchObject({
      source: "composio",
      provider: "hubspot",
      scope: "shared",
      connectedBy: admin.userId,
    });
  });

  it("records the admin's consent, with who gave it, then the connection", async () => {
    const admin = someone("admin");
    const { callback } = composio.authorize(await start(admin));
    const consented = await events();
    const { connectionId } = await back(admin, callback);
    const all = await events();
    expect(consented.map(({ action }) => action)).toStrictEqual([
      "connection.consent",
    ]);
    expect(consented[0]).toMatchObject({
      actor: { type: "person", userId: admin.userId },
      action: "connection.consent",
      detail: {
        provider: "hubspot",
        scope: "shared",
        outcome: "ok",
        tokenHolder: "composio",
        consentHash: await sha256Hex(composioConsentText),
        toolsHash: await sha256Hex(JSON.stringify(allowed)),
        toolCount: allowed.length,
      },
    });
    // One flow ties the consent to the connection it led to.
    const flowId = consented[0]?.detail.flowId;
    expect(flowId).toStrictEqual(expect.any(String));
    expect(all.at(-1)?.detail).toMatchObject({
      flowId,
      toolsHash: await sha256Hex(JSON.stringify(allowed)),
    });
    expect(all.at(-1)).toMatchObject({
      actor: { type: "person", userId: admin.userId },
      action: "connection.connect",
      target: { type: "connection", id: connectionId },
      detail: { provider: "hubspot", outcome: "ok", tokenHolder: "composio" },
    });
  });

  it("is only for admins, never Grasp staff, and asks Composio nothing for anyone else", async () => {
    const people = [someone("user"), { ...someone("admin"), staff: true }];
    const ends = await Promise.all(
      people.map(async (person) => await outcome(start(person)))
    );
    expect(ends).toStrictEqual([
      "role.forbidden",
      "connection.staff_not_allowed",
    ]);
    expect(composio.state.requests).toStrictEqual([]);
    // Both were asked at once, so their events may be stored in either order.
    const refused = await events();
    expect(
      refused
        .map(({ action, detail }) => `${action} ${String(detail.reason)}`)
        .toSorted()
    ).toStrictEqual([
      "connection.connect connection.staff_not_allowed",
      "connection.connect role.forbidden",
    ]);
  });

  it("needs the consent, word for word, and only tools the toolkit has and isn't retiring", async () => {
    const admin = someone("admin");
    const starts: Partial<Start>[] = [
      { consent: "I agree" },
      { consent: `${composioConsentText} ` },
      { tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_EXPORT_EVERYTHING"] },
      { tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_EXPORT_CONTACTS"] },
      { tools: [] },
      { tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_LIST_CONTACTS"] },
    ];
    const ends = await Promise.all(
      starts.map(async (options) => await outcome(start(admin, options)))
    );
    expect(ends).toStrictEqual(starts.map(() => "connection.invalid"));
    expect(composioWrites()).toStrictEqual([]);
    await expect(events()).resolves.toStrictEqual([]);
  });

  it("refuses a tool Composio doesn't tag read-only allowed as a read, connecting and changing tools, and makes nothing", async () => {
    const admin = someone("admin");
    const untaggedRead = [
      "HUBSPOT_LIST_CONTACTS",
      { name: "HUBSPOT_CREATE_CONTACT", read: true },
    ];
    const started = await outcome(start(admin, { tools: untaggedRead }));
    const writes = composioWrites();
    const connectionId = await connectHubSpot(admin);
    const changed = await outcome(change(admin, connectionId, untaggedRead));
    expect({ started, writes, changed }).toStrictEqual({
      started: "connection.invalid",
      writes: [],
      changed: "connection.invalid",
    });
  });

  it("is refused for a toolkit Composio holds no app for, recorded, and makes nothing at Composio", async () => {
    const admin = someone("admin");
    await expect(
      outcome(
        start(admin, { toolkit: "acme_erp", tools: ["ACME_ERP_LIST_ORDERS"] })
      )
    ).resolves.toBe("connection.own_auth_required");
    expect({
      writes: composioWrites(),
      held: heldAtComposio(),
      flows: await flowsOf(admin),
      cleanups: await cleanupsLeft(),
    }).toStrictEqual({ writes: [], held: nothingHeld, flows: 0, cleanups: 0 });
    const [refused, ...more] = await events();
    expect(more).toStrictEqual([]);
    expect(refused).toMatchObject({
      action: "connection.connect",
      detail: {
        provider: "acme_erp",
        outcome: "refused",
        reason: "connection.own_auth_required",
      },
    });
  });

  it("isn't offered while connect has no Composio key", async () => {
    const admin = someone("admin");
    await expect(
      outcome(
        connectWith({ COMPOSIO_API_KEY: undefined }).startToolkitConnection({
          person: admin,
          toolkit: "hubspot",
          tools: allowed,
          consent: composioConsentText,
          origin: clientOrigin,
          returnTo: "/connectors",
        })
      )
    ).resolves.toBe("connection.provider_unavailable");
    expect(composio.state.requests).toStrictEqual([]);
  });

  it("finishes only for the admin who started it, once, and deletes what it made at Composio otherwise", async () => {
    const admin = someone("admin");
    const other = someone("admin");
    const { callback } = composio.authorize(await start(admin));
    await expect(outcome(back(other, callback))).resolves.toBe(
      "connection.flow_invalid"
    );
    // Spent: not even the admin who started it can finish it now.
    await expect(outcome(back(admin, callback))).resolves.toBe(
      "connection.flow_invalid"
    );
    expect(heldAtComposio()).toStrictEqual({
      authConfigs: 0,
      accounts: 0,
      sessions: 0,
    });
  });

  it("connects an account Composio is still completing when it sends the browser back, once it is active", async () => {
    const admin = someone("admin");
    // Composio's redirect says success while the account still reads
    // INITIATED: its docs say to check again from the backend.
    const { callback } = composio.authorize(await start(admin), {
      pendingReads: 3,
    });
    const finished = await asTimePasses(
      async (connect) => await outcome(back(admin, callback, connect))
    );
    const [accountId = ""] = composio.state.holds.accounts.keys();
    const listed = await exports.default.listConnections(admin);
    const accountReads = composio.state.requests.filter(
      ({ method, path }) =>
        method === "GET" && path === `/connected_accounts/${accountId}`
    ).length;
    expect({
      finished,
      held: heldAtComposio(),
      connections: listed.filter(
        ({ connectedBy }) => connectedBy === admin.userId
      ).length,
      readAgain: accountReads > 1,
    }).toStrictEqual({
      finished: "ok",
      held: { authConfigs: 1, accounts: 1, sessions: 1 },
      connections: 1,
      readAgain: true,
    });
  });

  it("says the provider is still finishing when Composio doesn't complete the account in time, and keeps nothing", async () => {
    const admin = someone("admin");
    const { callback } = composio.authorize(await start(admin), {
      pendingReads: 1000,
    });
    const finished = await asTimePasses(
      async (connect) => await outcome(back(admin, callback, connect))
    );
    expect({
      finished,
      held: heldAtComposio(),
      cleanups: await cleanupsLeft(),
      ended: await connectsEnded(),
    }).toStrictEqual({
      finished: "connection.provider_pending",
      held: nothingHeld,
      cleanups: 0,
      ended: [["failed", "connection.provider_pending"]],
    });
  });

  it("asks again when Composio fails to read the account for a moment, or its answer breaks off, and connects", async () => {
    const admin = someone("admin");
    const ends = [];
    for (const broken of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      const { callback } = composio.authorize(await start(admin));
      composio.state.failingFor = {
        prefix: "GET /connected_accounts/",
        times: 2,
        broken,
      };
      ends.push(
        // oxlint-disable-next-line no-await-in-loop -- one flow at a time
        await asTimePasses(
          async (connect) => await outcome(back(admin, callback, connect))
        )
      );
    }
    expect({ ends, ended: await connectsEnded() }).toStrictEqual({
      ends: ["ok", "ok"],
      ended: [
        ["ok", null],
        ["ok", null],
      ],
    });
  });

  it("says the provider isn't answering when Composio never reads the account back, or its answer always breaks off, and keeps nothing", async () => {
    const admin = someone("admin");
    const ends = [];
    for (const broken of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      const { callback } = composio.authorize(await start(admin));
      composio.state.failingFor = {
        prefix: "GET /connected_accounts/",
        times: Number.POSITIVE_INFINITY,
        broken,
      };
      ends.push(
        // oxlint-disable-next-line no-await-in-loop -- one flow at a time
        await asTimePasses(
          async (connect) => await outcome(back(admin, callback, connect))
        )
      );
      composio.state.failingFor = undefined;
    }
    expect({
      ends,
      held: heldAtComposio(),
      cleanups: await cleanupsLeft(),
      ended: await connectsEnded(),
    }).toStrictEqual({
      ends: [
        "connection.provider_not_answering",
        "connection.provider_not_answering",
      ],
      held: nothingHeld,
      cleanups: 0,
      ended: [
        ["failed", "connection.provider_not_answering"],
        ["failed", "connection.provider_not_answering"],
      ],
    });
  });

  it("doesn't finish when the admin didn't connect at Composio, whatever its redirect says", async () => {
    const admin = someone("admin");
    const ends = [];
    const sends: { status: "ACTIVE" | "FAILED"; says?: string }[] = [
      // Composio says it failed: its account isn't even read.
      { status: "FAILED" },
      // Its redirect is a hint: the account as Composio holds it decides.
      { status: "FAILED", says: "success" },
    ];
    for (const send of sends) {
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      const { callback } = composio.authorize(await start(admin), send);
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      ends.push(await outcome(back(admin, callback)));
    }
    expect({ ends, held: heldAtComposio() }).toStrictEqual({
      ends: ["connection.provider_refused", "connection.provider_refused"],
      held: nothingHeld,
    });
  });

  it("says why each refusal ended, from a fixed set, to the admin and in the audit log", async () => {
    const admin = someone("admin");
    const refused = "connection.provider_refused";
    const forbidden = "connection.provider_forbidden";
    const cases: {
      why: string;
      ended?: string;
      send?: { status?: "ACTIVE" | "FAILED"; says?: string };
      before?: (account: FakeAccount) => void;
    }[] = [
      { why: "redirect_said_failed", send: { status: "FAILED" } },
      { why: "status:FAILED", send: { status: "FAILED", says: "success" } },
      {
        why: "mismatch:auth_config",
        before: (account) => {
          account.authConfigId = "ac_someone_elses";
        },
      },
      {
        why: "read:http_404",
        before: () => {
          composio.state.failingFor = {
            prefix: "GET /connected_accounts/",
            times: 1,
            status: 404,
          };
        },
      },
      // A key without Composio's MCP permission: no use starting again,
      // and Composio's number for it, never its message, names why.
      {
        why: "session:http_403:1001",
        ended: forbidden,
        before: () => {
          composio.state.failingFor = {
            prefix: "POST /tool_router/session",
            times: 1,
            status: 403,
          };
        },
      },
      {
        why: "session:http_401",
        ended: forbidden,
        before: () => {
          composio.state.failingFor = {
            prefix: "POST /tool_router/session",
            times: 1,
            status: 401,
          };
        },
      },
      {
        why: "session:http_422",
        before: () => {
          composio.state.failingFor = {
            prefix: "POST /tool_router/session",
            times: 1,
            status: 422,
          };
        },
      },
      {
        why: "session:config",
        before: () => {
          composio.state.answeredConfig = (config) => ({
            ...config,
            user_id: "someone-else.example",
          });
        },
      },
      {
        why: "url:host",
        before: () => {
          composio.state.sessionUrlBase =
            "https://mcp.attacker.example/api/v3/tool_router/session/";
        },
      },
      {
        why: "url:path",
        before: () => {
          composio.state.sessionUrlBase =
            "https://backend.composio.dev/api/v3/connected_accounts/";
        },
      },
    ];
    const endings = [];
    for (const { send, before } of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      const url = await start(admin);
      const { callback, account } = composio.authorize(url, send);
      before?.(account);
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      endings.push(await endingOf(back(admin, callback)));
      composio.state.failingFor = undefined;
      composio.state.answeredConfig = undefined;
      composio.state.sessionUrlBase = sessionUrlBase;
    }
    const recorded = await events();
    const audited = recorded
      .filter(({ action }) => action === "connection.connect")
      .map(({ detail }) => detail.why);
    expect({ endings, audited, held: heldAtComposio() }).toStrictEqual({
      endings: cases.map(({ why, ended = refused }) => [ended, why]),
      audited: cases.map(({ why }) => why),
      held: nothingHeld,
    });
  });

  it("says why a start was refused when Composio refuses to make its auth config or link", async () => {
    const admin = someone("admin");
    const failing = [
      ["POST /auth_configs", "auth_config:http_403:1001", 403],
      ["POST /connected_accounts/link", "link:http_503", 503],
    ] as const;
    const endings = [];
    for (const [prefix, , status] of failing) {
      composio.state.failingFor = { prefix, times: 1, status };
      // oxlint-disable-next-line no-await-in-loop -- one start at a time
      endings.push(await endingOf(start(admin)));
    }
    const recorded = await events();
    expect({
      endings,
      audited: recorded
        .filter(({ action }) => action === "connection.connect")
        .map(({ detail }) => detail.why),
      held: heldAtComposio(),
    }).toStrictEqual({
      endings: [
        ["connection.provider_forbidden", "auth_config:http_403:1001"],
        ["connection.provider_refused", "link:http_503"],
      ],
      audited: failing.map(([, why]) => why),
      held: nothingHeld,
    });
  });

  it("connects an account whose toolkit Composio names in capitals", async () => {
    const admin = someone("admin");
    const { callback } = composio.authorize(await start(admin));
    composio.state.slugCase = "upper";
    await expect(outcome(back(admin, callback))).resolves.toBe("ok");
  });

  it("connects only the flow's own account, whatever account the redirect names", async () => {
    const admin = someone("admin");
    const { callback } = composio.authorize(await start(admin));
    const [accountId = ""] = composio.state.holds.accounts.keys();
    const swapped = new URL(callback);
    swapped.searchParams.set("connected_account_id", "ca_someone_else");
    const { connectionId } = await back(admin, swapped.href);
    const connection = await stored(connectionId);
    expect(connection?.accountId).toBe(accountId);
  });

  it("stores nothing, and deletes what it made, when Composio fails on the way", async () => {
    const admin = someone("admin");
    const failures = ["POST /tool_router/session"];
    for (const failing of failures) {
      const { callback } = composio.authorize(
        // oxlint-disable-next-line no-await-in-loop -- one flow at a time
        await start(admin)
      );
      composio.state.failing = failing;
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      const ended = await outcome(back(admin, callback));
      composio.state.failing = undefined;
      expect(ended).toBe("connection.provider_refused");
    }
    expect(heldAtComposio()).toStrictEqual({
      authConfigs: 0,
      accounts: 0,
      sessions: 0,
    });
    const listed = await exports.default.listConnections(admin);
    expect(
      listed.filter(({ connectedBy }) => connectedBy === admin.userId)
    ).toStrictEqual([]);
  });

  it("doesn't store a session Composio says is anywhere but its own API host", async () => {
    const admin = someone("admin");
    const { callback } = composio.authorize(await start(admin));
    composio.state.sessionUrlBase =
      "https://mcp.attacker.example/api/v3/tool_router/session/";
    await expect(outcome(back(admin, callback))).resolves.toBe(
      "connection.provider_refused"
    );
    expect(heldAtComposio().sessions).toBe(0);
  });

  it("drops a flow nobody finished in time, and what it made at Composio", async () => {
    const admin = someone("admin");
    // The admin connected at Composio, and never came back.
    const { callback } = composio.authorize(await start(admin));
    await expireFlowsOf(admin);
    await runMaintenance();
    expect(heldAtComposio()).toStrictEqual({
      authConfigs: 0,
      accounts: 0,
      sessions: 0,
    });
    await expect(outcome(back(admin, callback))).resolves.toBe(
      "connection.flow_invalid"
    );
  });

  it("hands every flow of an admin removed from the organization over to cleanup at once, however many", async () => {
    const admin = someone("admin");
    const flows = 12;
    const callbacks: string[] = [];
    for (let flow = 0; flow < flows; flow += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      callbacks.push(composio.authorize(await start(admin)).callback);
    }
    await exports.default.disconnectPersonal({
      person: null,
      ownerUserIds: [admin.userId],
    });
    const handedOver = {
      flows: await flowsOf(admin),
      cleanups: await cleanupsLeft(),
    };
    // The clock deletes them at Composio, ten a run.
    await runMaintenance();
    await runMaintenance();
    expect({
      handedOver,
      held: heldAtComposio(),
      cleanups: await cleanupsLeft(),
      finished: await outcome(back(admin, callbacks[0] ?? "")),
    }).toStrictEqual({
      handedOver: { flows: 0, cleanups: flows },
      held: nothingHeld,
      cleanups: 0,
      finished: "connection.flow_invalid",
    });
  });

  it("makes nothing at Composio when it can't first record what it will make", async () => {
    const failed = await withTrigger(
      "BEFORE INSERT",
      async () => await outcome(start(someone("admin")))
    );
    expect({
      failed: failed !== "ok",
      held: heldAtComposio(),
      writes: composioWrites(),
      cleanups: await cleanupsLeft(),
    }).toStrictEqual({
      failed: true,
      held: nothingHeld,
      writes: [],
      cleanups: 0,
    });
  });

  it("finds by its marker an auth config whose ID it couldn't record and couldn't delete at once", async () => {
    const admin = someone("admin");
    composio.state.failing = "DELETE /";
    const failed = await withTrigger(
      "BEFORE UPDATE",
      async () => await outcome(start(admin))
    );
    composio.state.failing = undefined;
    const kept = { held: heldAtComposio(), cleanups: await cleanupsLeft() };
    await afterMinutes(6, async () => {
      await runMaintenance();
    });
    expect({
      failed: failed !== "ok",
      kept,
      after: { held: heldAtComposio(), cleanups: await cleanupsLeft() },
    }).toStrictEqual({
      failed: true,
      kept: { held: { ...nothingHeld, authConfigs: 1 }, cleanups: 1 },
      after: { held: nothingHeld, cleanups: 0 },
    });
  });

  it("leaves nothing reachable of a session whose ID it couldn't record and couldn't delete at once: its account and auth config go by the marker", async () => {
    const admin = someone("admin");
    const { callback } = composio.authorize(await start(admin));
    composio.state.failing = "DELETE /";
    const failed = await withTrigger(
      "BEFORE UPDATE",
      async () => await outcome(back(admin, callback))
    );
    composio.state.failing = undefined;
    const kept = heldAtComposio();
    await afterMinutes(6, async () => {
      await runMaintenance();
    });
    expect({
      failed: failed !== "ok",
      kept,
      after: { held: heldAtComposio(), cleanups: await cleanupsLeft() },
    }).toStrictEqual({
      failed: true,
      kept: { authConfigs: 1, accounts: 1, sessions: 1 },
      // A session has no name to find it by: it stays, pinned to an
      // account that is gone, so it reaches nothing.
      after: { held: { ...nothingHeld, sessions: 1 }, cleanups: 0 },
    });
  });

  it("takes no flow whose cleanup it can't record: nothing is deleted at Composio without a record, and nothing is lost", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    const failed = await withTrigger(
      "BEFORE INSERT",
      async () => await outcome(exports.default.abandonFlow(state))
    );
    const kept = { flows: await flowsOf(admin), held: heldAtComposio() };
    await exports.default.abandonFlow(state);
    expect({
      failed: failed !== "ok",
      kept,
      after: { flows: await flowsOf(admin), held: heldAtComposio() },
    }).toStrictEqual({
      failed: true,
      kept: { flows: 1, held: { ...nothingHeld, authConfigs: 1, accounts: 1 } },
      after: { flows: 0, held: nothingHeld },
    });
  });

  it("leaves a taken flow's cleanup for the clock when nothing gets to act on it", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    // As if the isolate went right after taking it: no key to act with.
    await connectWith({ COMPOSIO_API_KEY: undefined }).abandonFlow(state);
    const kept = await cleanupsLeft();
    await afterMinutes(6, async () => {
      await runMaintenance();
    });
    expect({
      kept,
      held: heldAtComposio(),
      left: await cleanupsLeft(),
    }).toStrictEqual({
      kept: 1,
      held: nothingHeld,
      left: 0,
    });
  });

  it("stores no session Composio made for another user or account, or with its own tools for connecting, searching or the workbench on, and deletes it", async () => {
    const admin = someone("admin");
    const answers: ((
      config: Record<string, unknown>
    ) => Record<string, unknown>)[] = [
      (config) => ({ ...config, user_id: "someone-else.example" }),
      (config) => ({
        ...config,
        connected_accounts: { hubspot: ["ca_someone_else"] },
      }),
      (config) => ({
        ...config,
        connected_accounts: { hubspot: ["ca_a", "ca_b"] },
      }),
      (config) => ({ ...config, manage_connections: { enabled: true } }),
      (config) => ({ ...config, search: { enable: true } }),
      (config) => ({ ...config, workbench: { enable: true } }),
      (config) => ({ ...config, proxy_execute: { enable: true } }),
      (config) => ({ ...config, instant: {} }),
    ];
    const ends = [];
    for (const answer of answers) {
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      const { callback } = composio.authorize(await start(admin));
      composio.state.answeredConfig = answer;
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      ends.push(await endingOf(back(admin, callback)));
      composio.state.answeredConfig = undefined;
    }
    expect({ ends, held: heldAtComposio() }).toStrictEqual({
      ends: answers.map(() => [
        "connection.provider_refused",
        "session:config",
      ]),
      held: nothingHeld,
    });
  });

  it("reads the role again when the admin comes back: someone no longer an admin can't finish", async () => {
    const admin = someone("admin");
    const { callback } = composio.authorize(await start(admin));
    await expect(
      outcome(back({ ...admin, role: "user" }, callback))
    ).resolves.toBe("role.forbidden");
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
  });

  it("deletes the auth config it made when starting fails midway, and records no consent", async () => {
    composio.state.failing = "POST /connected_accounts/link";
    await expect(outcome(start(someone("admin")))).resolves.toBe(
      "connection.provider_refused"
    );
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
    const recorded = await events();
    expect(
      recorded.map(({ action, detail }) => [action, detail.outcome])
    ).toStrictEqual([["connection.connect", "failed"]]);
  });

  it("keeps what it couldn't delete without a key, and deletes it once the key is back", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    const withoutKey = connectWith({ COMPOSIO_API_KEY: undefined });
    const finished = await outcome(
      withoutKey.finishConnection({ person: admin, state })
    );
    const kept = { held: heldAtComposio(), cleanups: await cleanupsLeft() };
    // Due once the finish would long be done.
    await afterMinutes(6, async () => {
      await runMaintenance({ COMPOSIO_API_KEY: undefined });
    });
    const stillKept = await cleanupsLeft();
    await afterMinutes(6, async () => {
      await runMaintenance();
    });
    expect({
      finished,
      kept,
      stillKept,
      after: { held: heldAtComposio(), cleanups: await cleanupsLeft() },
    }).toStrictEqual({
      finished: "connection.provider_unavailable",
      kept: {
        held: { ...nothingHeld, authConfigs: 1, accounts: 1 },
        cleanups: 1,
      },
      stillKept: 1,
      after: { held: nothingHeld, cleanups: 0 },
    });
  });

  it("keeps an expired flow's account to delete while connect has no key", async () => {
    const admin = someone("admin");
    composio.authorize(await start(admin));
    await expireFlowsOf(admin);
    await runMaintenance({ COMPOSIO_API_KEY: undefined });
    await expect(cleanupsLeft()).resolves.toBe(1);
    await afterMinutes(2, async () => {
      await runMaintenance();
    });
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
  });

  it("deletes what it made at Composio when a flow comes back but can't finish", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    await exports.default.abandonFlow(state);
    expect(heldAtComposio()).toStrictEqual({
      authConfigs: 0,
      accounts: 0,
      sessions: 0,
    });
  });
});

/**
 * Migration 0044's statements on stored data, as the release that adds
 * sessions runs them once: its columns are there already in tests.
 */
const migrateStoredData = async (): Promise<void> => {
  const migrations = z
    .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
    .parse(Reflect.get(env, "CONNECT_MIGRATIONS"));
  const queries =
    migrations
      .find(({ name }) => name.startsWith("0044_"))
      ?.queries.filter((query) => /^UPDATE /mu.test(query)) ?? [];
  expect(queries).toHaveLength(3);
  for (const query of queries) {
    // oxlint-disable-next-line no-await-in-loop -- in order, as a migration runs
    await env.DB.prepare(query).run();
  }
};

/** A connection as the legacy route stored it: a server, no session. */
const legacyConnection = async (status: "active" | "disconnected") =>
  await addConnection({
    provider: "hubspot",
    status,
    server: `https://backend.composio.dev/v3/mcp/${crypto.randomUUID()}?connected_account_id=ca_legacy`,
    composioServerId: crypto.randomUUID(),
    composioSessionId: null,
    accountId: "ca_legacy",
    tools: JSON.stringify(allowed),
  });

/** How connection `id` stands: its status, legacy server and update. */
const standing = async (id: string) =>
  await env.DB.prepare(
    "SELECT status, composio_server_id AS serverId, updated_at AS updatedAt FROM connections WHERE id = ?"
  )
    .bind(id)
    .first<{ status: string; serverId: string | null; updatedAt: number }>();

describe("a Composio connection made through Composio's legacy MCP servers", () => {
  it("asks to be connected again, once, keeps no legacy server, takes no call, and connecting again makes a session", async () => {
    const admin = someone("admin");
    const legacy = await legacyConnection("active");
    const gone = await legacyConnection("disconnected");
    const current = await connectHubSpot(admin);
    await env.DB.prepare(
      "INSERT INTO composio_cleanups (id, server_id, attempts, retry_at, created_at) VALUES (?, ?, 0, ?, ?)"
    )
      .bind(crypto.randomUUID(), "legacy-server", Date.now(), Date.now())
      .run();

    await migrateStoredData();
    const once = await standing(legacy);
    await migrateStoredData();
    const twice = await standing(legacy);
    const listed = await exports.default.listConnections(admin);
    const called = await outcome(
      callAs(agentFor("user-anna"), call(legacy, "HUBSPOT_LIST_CONTACTS"))
    );
    // Connecting again, as the Connectors page offers it: a new connection
    // beside the stopped one, served by a session.
    const again = await connectHubSpot(admin);
    await runMaintenance();
    const goneNow = await standing(gone);
    const currentNow = await standing(current);
    const againStored = await stored(again);
    const againNow = await standing(again);

    expect({
      once: { status: once?.status, serverId: once?.serverId },
      // Its second run finds nothing to change: not even its time.
      twice: twice?.updatedAt === once?.updatedAt,
      gone: goneNow?.status,
      current: currentNow?.status,
      listed: listed.find(({ id }) => id === legacy)?.status,
      called,
      again: {
        stored: againStored?.sessionId.startsWith("trs_"),
        status: againNow?.status,
      },
      cleanups: await cleanupsLeft(),
    }).toStrictEqual({
      once: { status: "needs_reauth", serverId: null },
      twice: true,
      gone: "disconnected",
      current: "active",
      listed: "needs_reauth",
      called: "connect.connection_inactive",
      again: { stored: true, status: "active" },
      cleanups: 0,
    });
  });

  it("is disconnected without asking Composio's legacy API anything, deleting its account and auth config", async () => {
    const admin = someone("admin");
    const { callback, account } = composio.authorize(await start(admin));
    const { connectionId } = await back(admin, callback);
    // As a connection made by the legacy route stands after the migration.
    await env.DB.prepare(
      "UPDATE connections SET status = 'needs_reauth', composio_session_id = NULL, server = ? WHERE id = ?"
    )
      .bind(
        "https://backend.composio.dev/v3/mcp/legacy?connected_account_id=ca_1",
        connectionId
      )
      .run();
    composio.state.holds.sessions.clear();

    await exports.default.disconnect({ person: admin, connectionId });

    expect({
      held: heldAtComposio(),
      account: [...composio.state.holds.accounts.values()].includes(account),
      cleanups: await cleanupsLeft(),
    }).toStrictEqual({ held: nothingHeld, account: false, cleanups: 0 });
  });
});

describe("a Composio connection", () => {
  const workflow = agentFor("user-anna");

  it("runs an allowed tool with connect's key, known by its toolkit and tool when it names no resources", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    const result = await callAs(
      workflow,
      call(connectionId, "HUBSPOT_LIST_CONTACTS")
    );
    expect(JSON.parse(result.output)).toStrictEqual({ contacts });
    expect(result.provenance).toStrictEqual(["hubspot/HUBSPOT_LIST_CONTACTS"]);
    expect(composio.state.mcp.ran).toStrictEqual([
      { tool: "HUBSPOT_LIST_CONTACTS", input: {} },
    ]);
    expect(composio.state.mcp.requests).toBeGreaterThan(0);
    expect(composio.state.mcp.unkeyed).toBe(0);
  });

  it("refuses a tool the admin didn't allow, without reaching Composio", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    await expect(
      outcome(callAs(workflow, call(connectionId, "HUBSPOT_UPDATE_CONTACT")))
    ).resolves.toBe("connect.action_not_found");
    expect(composio.state.mcp.requests).toBe(0);
    const recorded = await events();
    const refused = recorded.find(({ action }) => action === "connection.call");
    expect(refused?.detail).toMatchObject({
      action: "HUBSPOT_UPDATE_CONTACT",
      outcome: "refused",
      reason: "connect.action_not_found",
    });
  });

  it("holds a write from chat for the person to confirm", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    const inChat = agentFor("user-anna", "agent-chat", "interactive");
    const result = await callAs(
      inChat,
      call(connectionId, "HUBSPOT_CREATE_CONTACT")
    );
    expect(result.pending?.id).toBeTypeOf("string");
    expect(composio.state.mcp.ran).toStrictEqual([]);
  });

  it("is deleted at Composio when an admin disconnects it, and takes no more calls", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    await expect(
      exports.default.disconnect({ person: admin, connectionId })
    ).resolves.toStrictEqual({ revoked: true });
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
    await expect(
      outcome(callAs(workflow, call(connectionId, "HUBSPOT_LIST_CONTACTS")))
    ).resolves.toBe("connect.connection_inactive");
  });

  it("is deleted at Composio later when Composio doesn't take it at once, waiting longer after each failure", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    composio.state.failing = "DELETE /connected_accounts/";
    await expect(
      exports.default.disconnect({ person: admin, connectionId })
    ).resolves.toStrictEqual({ revoked: false });
    expect(heldAtComposio()).toStrictEqual({ ...nothingHeld, accounts: 1 });
    // Tried again after a minute, and failing, not again a minute later.
    await afterMinutes(2, async () => {
      await runMaintenance();
    });
    const tried = composio.state.requests.length;
    await afterMinutes(3, async () => {
      await runMaintenance();
    });
    expect(composio.state.requests).toHaveLength(tried);
    composio.state.failing = undefined;
    await afterMinutes(10, async () => {
      await runMaintenance();
    });
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
    await expect(cleanupsLeft()).resolves.toBe(0);
  });

  it("logs a cleanup Composio keeps refusing, once it has failed ten times", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    composio.state.failing = "DELETE /connected_accounts/";
    await exports.default.disconnect({ person: admin, connectionId });
    await env.DB.prepare("UPDATE composio_cleanups SET attempts = 9").run();
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    await afterMinutes(2, async () => {
      await runMaintenance();
    });
    expect(JSON.stringify(errors)).toContain("composio.cleanup_stuck");
    expect(JSON.stringify(errors)).not.toContain(connectionId);
  });

  it("stops taking calls when disconnected, even if clearing its cleanup fails after Composio deleted it", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const revoked = await withTrigger(
      "BEFORE DELETE",
      async () =>
        await exports.default.disconnect({ person: admin, connectionId })
    );
    const inactive = await outcome(
      callAs(workflow, call(connectionId, "HUBSPOT_LIST_CONTACTS"))
    );
    const kept = await cleanupsLeft();
    await afterMinutes(2, async () => {
      await runMaintenance();
    });
    expect({
      revoked,
      inactive,
      held: heldAtComposio(),
      kept,
      left: await cleanupsLeft(),
    }).toStrictEqual({
      revoked: { revoked: true },
      inactive: "connect.connection_inactive",
      held: nothingHeld,
      kept: 1,
      left: 0,
    });
  });

  it("deletes nothing at Composio when its disconnect can't be recorded", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const failed = await withTrigger(
      "BEFORE INSERT",
      async () =>
        await outcome(
          exports.default.disconnect({ person: admin, connectionId })
        )
    );
    expect({
      failed: failed !== "ok",
      held: heldAtComposio(),
      calls: await outcome(
        callAs(workflow, call(connectionId, "HUBSPOT_LIST_CONTACTS"))
      ),
    }).toStrictEqual({
      failed: true,
      held: { authConfigs: 1, accounts: 1, sessions: 1 },
      calls: "ok",
    });
  });

  it("tells Grasp's staff whether Composio says its account still works, and nothing Composio knows it by", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    const held = await stored(connectionId);
    const accountId = held?.accountId ?? "";
    /** What staff read of it now, through `connect`. */
    const read = async (
      list: () => Promise<OrganizationConnection[]> = async () =>
        await exports.default.organizationConnections()
    ) => {
      const listed = await list();
      return {
        text: JSON.stringify(listed),
        composio: listed.find(({ id }) => id === connectionId)?.composio,
      };
    };
    const active = await read();
    const account = composio.state.holds.accounts.get(accountId);
    if (account !== undefined) {
      account.status = "FAILED";
    }
    const failed = await read();
    composio.state.failing = "GET /connected_accounts/";
    const unanswered = await read();
    composio.state.failing = undefined;
    composio.state.holds.accounts.delete(accountId);
    const gone = await read();
    const keyless = await read(
      async () =>
        await connectWith({
          COMPOSIO_API_KEY: undefined,
        }).organizationConnections()
    );
    expect({
      states: [active, failed, unanswered, gone, keyless].map(
        ({ composio: state }) => state
      ),
      leaked: [held?.server, held?.sessionId, accountId].filter(
        (secret) =>
          secret !== undefined &&
          secret !== "" &&
          [active, failed, gone].some(({ text }) => text.includes(secret))
      ),
    }).toStrictEqual({
      // Expired or failed at Composio, or gone from it, it stopped; while
      // Composio can't be asked, or connect has no key, nobody can say.
      states: ["active", "stopped", "unread", "stopped", "unread"],
      leaked: [],
    });
  });

  it("takes no calls while connect has no Composio key", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    await expect(
      outcome(
        callAs(
          workflow,
          call(connectionId, "HUBSPOT_LIST_CONTACTS"),
          {},
          connectWith({ COMPOSIO_API_KEY: undefined })
        )
      )
    ).resolves.toBe("connect.server_unavailable");
    expect(composio.state.mcp.requests).toBe(0);
  });
});

const serverOf = async (connectionId: string) => {
  const row = await stored(connectionId);
  return row?.sessionId ?? "";
};

describe("changing what a connected Composio toolkit may do", () => {
  const workflow = agentFor("user-anna");

  it("changes the tools at Composio and in connect for an admin, audited, and calls follow at once", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const changed = await change(admin, connectionId, [
      { name: "HUBSPOT_LIST_CONTACTS", read: true },
      "HUBSPOT_UPDATE_CONTACT",
    ]);
    const listed = await exports.default.listConnections(admin);
    const recorded = await events();
    const event = recorded.find(({ action }) => action === "connection.tools");
    const storedNow: unknown = JSON.parse(
      (await toolsNow(connectionId)) ?? "null"
    );

    expect({
      changed,
      stored: storedNow,
      composio: sessionTools(),
      update: await outcome(
        callAs(workflow, call(connectionId, "HUBSPOT_UPDATE_CONTACT"))
      ),
      taken: await outcome(
        callAs(workflow, call(connectionId, "HUBSPOT_CREATE_CONTACT"))
      ),
      listed: listed.find(({ id }) => id === connectionId)?.readTools,
      event: event?.detail,
      came: namesIn(recorded, "connection.tools.added"),
      went: namesIn(recorded, "connection.tools.removed"),
    }).toMatchObject({
      changed: { tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_UPDATE_CONTACT"] },
      stored: [
        { name: "HUBSPOT_LIST_CONTACTS", read: true },
        "HUBSPOT_UPDATE_CONTACT",
      ],
      composio: [["HUBSPOT_LIST_CONTACTS", "HUBSPOT_UPDATE_CONTACT"]],
      update: "ok",
      taken: "connect.action_not_found",
      listed: ["HUBSPOT_LIST_CONTACTS"],
      event: {
        outcome: "ok",
        toolCount: 2,
        readCount: 1,
        added: 1,
        removed: 1,
      },
      // Who allowed which tool, and took which away, by name.
      came: ["HUBSPOT_UPDATE_CONTACT"],
      went: ["HUBSPOT_CREATE_CONTACT"],
    });
  });

  it("is only for admins, never Grasp staff, recorded, and asks Composio nothing for anyone else", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    const before = await toolsNow(connectionId);
    const people = [someone("user"), { ...someone("admin"), staff: true }];
    const ends = await Promise.all(
      people.map(
        async (person) =>
          await outcome(
            change(person, connectionId, ["HUBSPOT_UPDATE_CONTACT"])
          )
      )
    );
    const all = await events();
    const refused = all.filter(({ action }) => action === "connection.tools");

    expect({
      ends,
      updates: updates(),
      unchanged: (await toolsNow(connectionId)) === before,
      refused: refused
        .map(({ detail }) => String(detail.reason))
        .toSorted((a, b) => a.localeCompare(b)),
    }).toStrictEqual({
      ends: ["role.forbidden", "connection.staff_not_allowed"],
      updates: [],
      unchanged: true,
      refused: ["connection.staff_not_allowed", "role.forbidden"],
    });
  });

  it("refuses a change made from a page another change made stale, recorded, putting nothing back", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const shown = await shownTools(connectionId);
    // Another admin narrows it to one tool first.
    await change(admin, connectionId, ["HUBSPOT_LIST_CONTACTS"]);
    const narrowed = await toolsNow(connectionId);
    const sentBefore = updates().length;
    // The stale page sends its whole list, with one more tool.
    const stale = await outcome(
      change(admin, connectionId, [...shown, "HUBSPOT_UPDATE_CONTACT"], shown)
    );
    const recorded = await events();
    const refused = recorded.filter(
      ({ action, detail }) =>
        action === "connection.tools" && detail.outcome === "refused"
    );

    expect({
      stale,
      unchanged: (await toolsNow(connectionId)) === narrowed,
      sent: updates().length - sentBefore,
      reasons: refused.map(({ detail }) => detail.reason),
    }).toStrictEqual({
      stale: "connection.tools_changed",
      unchanged: true,
      sent: 0,
      reasons: ["connection.tools_changed"],
    });
  });

  it("records a change it couldn't check because Composio's catalog was away", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    // Its tools as connecting read them, forgotten: read again, and away.
    forgetComposioCatalog();
    composio.state.failing = "GET /tools";
    const end = await outcome(
      change(admin, connectionId, ["HUBSPOT_UPDATE_CONTACT"])
    );
    const recorded = await events();
    const failed = recorded.filter(
      ({ action, detail }) =>
        action === "connection.tools" && detail.outcome === "failed"
    );

    expect({
      end,
      reasons: failed.map(({ detail }) => detail.reason),
    }).toStrictEqual({
      end: "connect.catalog_unavailable",
      reasons: ["connect.catalog_unavailable"],
    });
  });

  it("allows only tools the toolkit has and isn't retiring, of a connection it can change, and changes nothing at Composio otherwise", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const ends = [
      await outcome(change(admin, connectionId, ["HUBSPOT_EXPORT_EVERYTHING"])),
      await outcome(
        change(admin, connectionId, [
          "HUBSPOT_LIST_CONTACTS",
          "HUBSPOT_EXPORT_CONTACTS",
        ])
      ),
      await outcome(change(admin, connectionId, [])),
      await outcome(
        change(admin, "no-such-connection", ["HUBSPOT_LIST_CONTACTS"])
      ),
    ];
    await exports.default.disconnect({ person: admin, connectionId });
    ends.push(
      await outcome(change(admin, connectionId, ["HUBSPOT_LIST_CONTACTS"]))
    );

    expect({ ends, updates: updates() }).toStrictEqual({
      ends: [
        "connection.invalid",
        "connection.invalid",
        "connection.invalid",
        "connect.connection_not_found",
        "connect.connection_not_found",
      ],
      updates: [],
    });
  });

  it("changes nothing when Composio doesn't take the change, and records that it failed", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const before = await toolsNow(connectionId);
    composio.state.failing = "PATCH /tool_router/session/";
    const end = await outcome(
      change(admin, connectionId, ["HUBSPOT_UPDATE_CONTACT"])
    );
    const recorded = await events();

    // Composio refuses the setting back as well: recorded, and left marked
    // for the clock to finish.
    expect({
      end,
      unchanged: (await toolsNow(connectionId)) === before,
      failed: recorded
        .filter(({ action }) => action === "connection.tools")
        .map(({ detail }) => [detail.outcome, detail.reason]),
    }).toStrictEqual({
      end: "connection.provider_refused",
      unchanged: true,
      failed: [
        ["failed", "connection.tools_restore_failed"],
        ["failed", "connection.provider_refused"],
      ],
    });
  });

  it("records it as failed when Composio can't be set back after a change another one beat", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    composio.state.beforeUpdate = async () => {
      await env.DB.prepare("UPDATE connections SET tools = ? WHERE id = ?")
        .bind(JSON.stringify(["HUBSPOT_LIST_CONTACTS"]), connectionId)
        .run();
      // And Composio takes no update after this one.
      composio.state.failing = "PATCH /tool_router/session/";
    };
    const end = await outcome(
      change(admin, connectionId, ["HUBSPOT_UPDATE_CONTACT"])
    );
    const recorded = await events();

    expect({
      end,
      reasons: recorded
        .filter(({ action }) => action === "connection.tools")
        .map(({ detail }) => [detail.outcome, detail.reason]),
    }).toStrictEqual({
      end: "connection.tools_changed",
      reasons: [
        ["failed", "connection.tools_restore_failed"],
        ["refused", "connection.tools_changed"],
      ],
    });
  });

  it("records it as failed when anything but Composio goes wrong on the way, and changes nothing", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const before = await toolsNow(connectionId);
    const { info } = log;
    const broken = vi.spyOn(log, "info").mockImplementation((event, fields) => {
      if (event === "composio.request" && fields?.method === "PATCH") {
        throw new Error("Logging broke");
      }
      info(event, fields);
    });
    let end: string;
    try {
      end = await outcome(
        change(admin, connectionId, ["HUBSPOT_UPDATE_CONTACT"])
      );
    } finally {
      broken.mockRestore();
    }
    const recorded = await events();

    expect({
      end,
      unchanged: (await toolsNow(connectionId)) === before,
      failed: recorded
        .filter(({ action }) => action === "connection.tools")
        .map(({ detail }) => [detail.outcome, detail.reason]),
    }).toStrictEqual({
      end: "Error: Logging broke",
      unchanged: true,
      failed: [
        ["failed", "connection.tools_restore_failed"],
        ["failed", "connection.change_failed"],
      ],
    });
  });

  it("refuses a change another one beat, and sets Composio back to what connect holds", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const theirs = JSON.stringify(["HUBSPOT_LIST_CONTACTS"]);
    // Another admin's change lands while this one is at Composio.
    composio.state.beforeUpdate = async () => {
      await env.DB.prepare("UPDATE connections SET tools = ? WHERE id = ?")
        .bind(theirs, connectionId)
        .run();
    };
    const end = await outcome(
      change(admin, connectionId, ["HUBSPOT_UPDATE_CONTACT"])
    );
    const afterwards = await events();

    expect({
      end,
      stored: await toolsNow(connectionId),
      composio: sessionTools(),
      ok: afterwards.filter(
        ({ action, detail }) =>
          action === "connection.tools" && detail.outcome === "ok"
      ).length,
    }).toStrictEqual({
      end: "connection.tools_changed",
      stored: theirs,
      composio: [["HUBSPOT_LIST_CONTACTS"]],
      ok: 0,
    });
  });

  it("leaves Composio on connect's latest list when a newer change lands while a lost one sets Composio back", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const theirs = JSON.stringify(["HUBSPOT_LIST_CONTACTS"]);
    const newest = ["HUBSPOT_UPDATE_CONTACT", "HUBSPOT_LIST_CONTACTS"];
    // Another change beats this one while it is at Composio; as this one
    // sets Composio back to that, a third lands, at Composio first.
    composio.state.beforeUpdate = async () => {
      await env.DB.prepare("UPDATE connections SET tools = ? WHERE id = ?")
        .bind(theirs, connectionId)
        .run();
      composio.state.beforeUpdate = async () => {
        await env.DB.prepare("UPDATE connections SET tools = ? WHERE id = ?")
          .bind(JSON.stringify(newest), connectionId)
          .run();
        for (const server of composio.state.holds.sessions.values()) {
          server.allowedTools = newest;
        }
      };
    };
    const end = await outcome(
      change(admin, connectionId, ["HUBSPOT_CREATE_CONTACT"])
    );

    expect({
      end,
      stored: await toolsNow(connectionId),
      composio: sessionTools(),
    }).toStrictEqual({
      end: "connection.tools_changed",
      stored: JSON.stringify(newest),
      composio: [newest],
    });
  });

  it("sets Composio back when connect can't save a change Composio took, and records it failed", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const before = await toolsNow(connectionId);
    // Connect's database refuses the change once Composio has it.
    composio.state.beforeUpdate = async () => {
      await env.DB.prepare(
        "CREATE TRIGGER refuse_tools BEFORE UPDATE OF tools ON connections BEGIN SELECT RAISE(ABORT, 'refused'); END"
      ).run();
    };
    let end: string;
    try {
      end = await outcome(
        change(admin, connectionId, ["HUBSPOT_UPDATE_CONTACT"])
      );
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS refuse_tools").run();
    }
    const recorded = await events();

    expect({
      failed: end !== "ok",
      unchanged: (await toolsNow(connectionId)) === before,
      composio: sessionTools(),
      reasons: recorded
        .filter(({ action }) => action === "connection.tools")
        .map(({ detail }) => [detail.outcome, detail.reason]),
    }).toStrictEqual({
      failed: true,
      unchanged: true,
      composio: [
        composioToolsSchema
          .parse(JSON.parse(before ?? "[]"))
          .map(composioToolName),
      ],
      reasons: [["failed", "connection.change_failed"]],
    });
  });

  it("keeps the tools a change names in the same transaction as the change, so a retry still records them", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const before = await toolsNow(connectionId);
    // The log refuses the event naming the tool added, once.
    await env.DB.prepare(
      "CREATE TRIGGER refuse_names BEFORE INSERT ON audit_outbox WHEN NEW.event LIKE '%connection.tools.added%' BEGIN SELECT RAISE(ABORT, 'refused'); END"
    ).run();
    let first: string;
    try {
      first = await outcome(
        change(admin, connectionId, ["HUBSPOT_UPDATE_CONTACT"])
      );
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS refuse_names").run();
    }
    const unchanged = (await toolsNow(connectionId)) === before;
    // Sent again, it is made, with its names.
    await change(admin, connectionId, ["HUBSPOT_UPDATE_CONTACT"]);
    const recorded = await events();

    expect({
      first: first !== "ok",
      unchanged,
      stored: await toolsNow(connectionId),
      came: namesIn(recorded, "connection.tools.added"),
    }).toStrictEqual({
      first: true,
      unchanged: true,
      stored: JSON.stringify(["HUBSPOT_UPDATE_CONTACT"]),
      came: ["HUBSPOT_UPDATE_CONTACT"],
    });
  });

  it("lists each tool's resource property, so a page changing the tools can keep it", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    await change(admin, connectionId, [
      { name: "HUBSPOT_LIST_CONTACTS", read: true, resource: "pipeline" },
      "HUBSPOT_UPDATE_CONTACT",
    ]);
    const listed = await exports.default.listConnections(admin);

    expect(
      listed.find(({ id }) => id === connectionId)?.toolResources
    ).toStrictEqual({ HUBSPOT_LIST_CONTACTS: "pipeline" });
  });

  it("tells Composio of the tools a change adds only once connect holds them", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    let beforeWrite: string[][] = [];
    // What Composio allows after the first update, the one before connect's write.
    composio.state.beforeUpdate = async () => {
      composio.state.beforeUpdate = async () => {
        beforeWrite = sessionTools();
        await Promise.resolve();
      };
      await Promise.resolve();
    };
    await change(admin, connectionId, [
      "HUBSPOT_LIST_CONTACTS",
      "HUBSPOT_UPDATE_CONTACT",
    ]);

    expect({ beforeWrite, after: sessionTools() }).toStrictEqual({
      beforeWrite: [["HUBSPOT_LIST_CONTACTS"]],
      after: [["HUBSPOT_LIST_CONTACTS", "HUBSPOT_UPDATE_CONTACT"]],
    });
  });

  it("keeps or drops a tool its toolkit no longer has, but adds none it lacks", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    // Allowed when connected; Composio has since retired it.
    const retired = ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_RETIRED_TOOL"];
    await env.DB.prepare("UPDATE connections SET tools = ? WHERE id = ?")
      .bind(JSON.stringify(retired), connectionId)
      .run();
    const kept = await outcome(
      change(admin, connectionId, [...retired, "HUBSPOT_CREATE_CONTACT"])
    );
    const keptNow = await toolsNow(connectionId);
    const added = await outcome(
      change(admin, connectionId, [...retired, "HUBSPOT_NEVER_WAS"])
    );
    const dropped = await outcome(
      change(admin, connectionId, ["HUBSPOT_LIST_CONTACTS"])
    );

    expect({
      kept,
      keptNow,
      added,
      dropped,
      after: await toolsNow(connectionId),
    }).toStrictEqual({
      kept: "ok",
      keptNow: JSON.stringify([...retired, "HUBSPOT_CREATE_CONTACT"]),
      added: "connection.invalid",
      dropped: "ok",
      after: JSON.stringify(["HUBSPOT_LIST_CONTACTS"]),
    });
  });

  it("marks a connection whose Composio couldn't be brought in line, and the clock does it later", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    // Composio takes the narrowed update, then none for a while.
    composio.state.beforeUpdate = async () => {
      composio.state.failing = "PATCH /tool_router/session/";
      await Promise.resolve();
    };
    await change(admin, connectionId, [
      "HUBSPOT_LIST_CONTACTS",
      "HUBSPOT_UPDATE_CONTACT",
    ]);
    const marked = await outOfSync(connectionId);
    composio.state.failing = undefined;
    vi.useFakeTimers({ toFake: ["Date"] });
    let still: boolean;
    try {
      // Past the wait after its first failure.
      vi.setSystemTime(Date.now() + 61_000);
      await reconcileUnsyncedTools(env);
      still = await outOfSync(connectionId);
    } finally {
      vi.useRealTimers();
    }

    expect({ marked, composio: sessionTools(), still }).toStrictEqual({
      marked: true,
      composio: [["HUBSPOT_LIST_CONTACTS", "HUBSPOT_UPDATE_CONTACT"]],
      still: false,
    });
  });

  it("marks a connection before Composio is told, so a send a crash cuts short is still repaired", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    let whileTold = false;
    composio.state.beforeUpdate = async () => {
      whileTold = await outOfSync(connectionId);
    };
    await change(admin, connectionId, ["HUBSPOT_LIST_CONTACTS"]);

    expect({
      markedWhileTold: whileTold,
      afterwards: await outOfSync(connectionId),
    }).toStrictEqual({ markedWhileTold: true, afterwards: false });
  });

  it("keeps reconciling newer marked connections while older ones keep failing", async () => {
    const admin = someone("admin");
    await env.DB.prepare(
      "UPDATE connections SET tools_settled_seq = tools_sent_seq"
    ).run();
    const marked: string[] = [];
    for (let n = 0; n < 21; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      marked.push(await connectHubSpot(admin));
    }
    const marks = marked.map((connectionId) =>
      env.DB.prepare(
        "UPDATE connections SET tools_sent_seq = tools_settled_seq + 1 WHERE id = ?"
      ).bind(connectionId)
    );
    await env.DB.batch(marks);
    // 20 of them are gone at Composio, so theirs keep failing;
    // the newest one only lags connect.
    const failing = marked.slice(0, 20);
    const newest = marked[20] ?? "";
    for (const connectionId of failing) {
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      composio.state.holds.sessions.delete(await serverOf(connectionId));
    }
    const newestServer = composio.state.holds.sessions.get(
      await serverOf(newest)
    );
    const lagging = [...(newestServer?.allowedTools ?? [])];
    if (newestServer !== undefined) {
      newestServer.allowedTools = [];
    }
    await reconcileUnsyncedTools(env);
    await reconcileUnsyncedTools(env);
    const state = await env.DB.prepare(
      "SELECT id, tools_sent_seq > tools_settled_seq AS unsynced, tools_sync_failures AS failures FROM connections WHERE tools_sent_seq > tools_settled_seq OR id = ?"
    )
      .bind(newest)
      .all<{ id: string; unsynced: number; failures: number }>();
    const newestNow = state.results.find(({ id }) => id === newest);
    const stillFailing = state.results.filter(({ id }) => failing.includes(id));

    expect({
      newestUnsynced: newestNow?.unsynced,
      newestAtComposio: newestServer?.allowedTools,
      stillMarked: stillFailing.length,
      // Each tried once, then put off: not again in the same minute.
      failures: [...new Set(stillFailing.map(({ failures }) => failures))],
    }).toStrictEqual({
      newestUnsynced: 0,
      newestAtComposio: lagging,
      stillMarked: 20,
      failures: [1],
    });
  });

  it("takes a change whose write landed but whose answer was lost as made, and records no failure", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    let toolsWrite = false;
    let lost = false;
    const db = new Proxy(env.DB, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property);
        if (property === "prepare") {
          return (query: string): unknown => {
            if (/^update "connections" set "tools"/iu.test(query)) {
              toolsWrite = true;
            }
            return target.prepare(query);
          };
        }
        if (property === "batch") {
          return async (
            statements: D1PreparedStatement[]
          ): Promise<unknown> => {
            const answer: unknown = await target.batch(statements);
            if (toolsWrite && !lost) {
              lost = true;
              throw new Error("The answer was lost");
            }
            return answer;
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const result = await changeToolkitTools(
      { ...env, DB: db },
      {
        person: admin,
        connectionId,
        tools: ["HUBSPOT_UPDATE_CONTACT"],
        expected: await shownTools(connectionId),
      }
    );
    const recorded = await events();

    expect({
      result,
      lost,
      outcomes: recorded
        .filter(({ action }) => action === "connection.tools")
        .map(({ detail }) => [detail.outcome, detail.reason ?? null]),
    }).toStrictEqual({
      result: { tools: ["HUBSPOT_UPDATE_CONTACT"] },
      lost: true,
      outcomes: [["ok", null]],
    });
  });

  it("drops a held action of a tool taken away, so nobody is asked to confirm it", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const inChat = agentFor("user-anna", "agent-chat", "interactive");
    const held = await callAs(
      inChat,
      call(connectionId, "HUBSPOT_CREATE_CONTACT")
    );
    await change(admin, connectionId, ["HUBSPOT_LIST_CONTACTS"]);
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pending_actions WHERE id = ?"
    )
      .bind(held.pending?.id ?? "")
      .first<{ n: number }>();
    const recorded = await events();
    const dropped = recorded.find(
      ({ action }) => action === "connection.action.dropped"
    );

    expect({
      held: typeof held.pending?.id,
      left: left?.n,
      reason: dropped?.detail.reason,
    }).toStrictEqual({
      held: "string",
      left: 0,
      reason: "connection.tools_changed",
    });
  });

  it("keeps a held action whose tool a newer change allowed again before it is dropped", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const inChat = agentFor("user-anna", "agent-chat", "interactive");
    const held = await callAs(
      inChat,
      call(connectionId, "HUBSPOT_CREATE_CONTACT")
    );
    // Narrowed first; by the time Composio is brought in line, a newer
    // change has allowed the held action's tool again.
    const heldNow = async () => {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM pending_actions WHERE id = ?"
      )
        .bind(held.pending?.id ?? "")
        .first<{ n: number }>();
      return row?.n;
    };
    let whileNarrowing: number | undefined;
    composio.state.beforeUpdate = async () => {
      whileNarrowing = await heldNow();
      composio.state.beforeUpdate = async () => {
        await env.DB.prepare("UPDATE connections SET tools = ? WHERE id = ?")
          .bind(
            JSON.stringify(["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_CONTACT"]),
            connectionId
          )
          .run();
      };
    };
    await change(admin, connectionId, ["HUBSPOT_LIST_CONTACTS"]);
    const left = await heldNow();
    const recorded = await events();

    expect({
      whileNarrowing,
      left,
      dropped: recorded.some(
        ({ action }) => action === "connection.action.dropped"
      ),
    }).toStrictEqual({ whileNarrowing: 1, left: 1, dropped: false });
  });
});
