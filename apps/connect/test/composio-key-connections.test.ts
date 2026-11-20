import {
  composioConsentText,
  composioKeyConsentText,
  connectionErrors,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  call,
  cleanupsLeft,
  composio,
  composioWrites,
  connectWithKey,
  events,
  heldAtComposio,
  nothingHeld,
  pipedeskKey,
  stored,
} from "./composio-connections-harness.ts";
import { agentFor, callAs, clientOrigin, outcome, someone } from "./connect.ts";

// Connecting a Composio toolkit that takes a key (GRA-2206): an admin types
// it into Grasp's own form, with the other fields Composio describes, and
// connect passes it to Composio in one request. Nobody is sent to
// Composio's site. The key is never stored, logged, audited or answered by
// connect: only Composio holds it. Threat model on the Linear issue.

/** Every log line written while `run` runs, as JSON, and what it ended in. */
const logged = async (
  run: () => Promise<unknown>
): Promise<{ lines: string; ended: unknown }> => {
  const lines: string[] = [];
  for (const method of ["info", "warn", "error", "log", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    });
  }
  let ended: unknown;
  try {
    ended = await run();
  } catch (error) {
    ended = error;
  }
  return { lines: lines.join("\n"), ended };
};

/** Every row of every table of connect's database, as one text. */
const everythingStored = async (): Promise<string> => {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
  ).all<{ name: string }>();
  const rows = await Promise.all(
    tables.map(async ({ name }) => {
      const { results } = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      return results;
    })
  );
  return JSON.stringify(rows);
};

/** An error as whoever made the call gets it, as text. */
const errorText = (error: unknown): string =>
  error instanceof Error
    ? JSON.stringify(error, Object.getOwnPropertyNames(error))
    : JSON.stringify(error);

describe("connecting a Composio toolkit with a key", () => {
  it("serves the fields Composio describes, each secret unless Composio says it isn't, and none it hides", async () => {
    const fields = await exports.default.toolkitKeyFields({
      person: someone("admin"),
      toolkit: "pipedesk",
    });
    expect(fields).toStrictEqual([
      {
        name: "generic_api_key",
        label: "API key",
        description: "Your generic_api_key",
        required: true,
        secret: true,
      },
      {
        name: "subdomain",
        label: "Subdomain",
        description: "Your subdomain",
        required: true,
        secret: false,
      },
      {
        name: "region",
        label: "Region",
        description: "Your region",
        required: false,
        secret: true,
      },
    ]);
  });

  it("serves Composio's fields however long their text, without an optional one it can't read, and nothing for a toolkit whose required field it can't read", async () => {
    const admin = someone("admin");
    const wordy = await exports.default.toolkitKeyFields({
      person: admin,
      toolkit: "wordydesk",
    });
    const ends = await Promise.all([
      outcome(
        exports.default.toolkitKeyFields({
          person: admin,
          toolkit: "brokendesk",
        })
      ),
      outcome(
        connectWithKey(admin, {
          toolkit: "brokendesk",
          tools: ["BROKENDESK_LIST"],
          values: { username: "someone" },
        })
      ),
    ]);
    expect({ wordy, ends, writes: composioWrites() }).toStrictEqual({
      wordy: [
        {
          name: "token",
          label: `Token ${"t".repeat(300)}`,
          description: "d".repeat(5000),
          required: true,
          secret: true,
        },
      ],
      ends: ["connect.catalog_unavailable", "connect.catalog_unavailable"],
      writes: [],
    });
  });

  it("serves no fields for a toolkit that signs in, or takes an app nobody registered, nor to anyone but an admin", async () => {
    const admin = someone("admin");
    const asked = [
      { person: admin, toolkit: "hubspot" },
      { person: admin, toolkit: "acme_erp" },
      { person: someone("user"), toolkit: "pipedesk" },
      { person: { ...admin, staff: true }, toolkit: "pipedesk" },
    ];
    const ends = await Promise.all(
      asked.map(
        async (request) =>
          await outcome(exports.default.toolkitKeyFields(request))
      )
    );
    expect(ends).toStrictEqual([
      "connection.invalid",
      "connection.own_auth_required",
      "role.forbidden",
      "connection.staff_not_allowed",
    ]);
  });

  it("connects with what the admin typed, which Composio holds and connect keeps nowhere", async () => {
    const admin = someone("admin");
    const { lines, ended } = await logged(
      async () => await connectWithKey(admin)
    );
    const connectionId = String(ended);

    await expect(stored(connectionId)).resolves.toMatchObject({
      provider: "pipedesk",
      scope: "shared",
      serverKind: "composio",
      tools: '["PIPEDESK_LIST_DEALS"]',
    });
    // Composio got it once, in its own auth config with empty credentials,
    // for this deployment's Composio user; no browser went to Composio, as
    // no auth link was asked for.
    const [authConfig] = composio.state.holds.authConfigs.values();
    const [account] = composio.state.holds.accounts.values();
    const linked = composio.state.requests.some(
      ({ path }) => path === "/connected_accounts/link"
    );
    expect({ authConfig, account, linked }).toMatchObject({
      linked: false,
      authConfig: {
        toolkit: "pipedesk",
        managed: false,
        scheme: "API_KEY",
        credentials: {},
      },
      account: {
        toolkit: "pipedesk",
        userId: new URL(clientOrigin).host,
        status: "ACTIVE",
        state: {
          authScheme: "API_KEY",
          val: {
            generic_api_key: pipedeskKey,
            subdomain: "acme",
            status: "ACTIVE",
          },
        },
      },
    });
    // It works as any Composio connection.
    const result = await callAs(
      agentFor("user-anna"),
      call(connectionId, "PIPEDESK_LIST_DEALS")
    );
    expect(JSON.parse(result.output)).toStrictEqual({ deals: ["deal-1"] });

    const recorded = await events();
    expect(
      recorded
        .filter(({ action }) => action !== "connection.call")
        .map(({ action, actor, detail }) => ({ action, actor, detail }))
    ).toMatchObject([
      {
        action: "connection.consent",
        actor: { userId: admin.userId },
        detail: {
          provider: "pipedesk",
          tokenHolder: "composio",
          consentHash: await sha256Hex(composioKeyConsentText),
          scheme: "API_KEY",
          fields: "generic_api_key,subdomain",
        },
      },
      {
        action: "connection.connect",
        actor: { userId: admin.userId },
        detail: {
          provider: "pipedesk",
          outcome: "ok",
          scheme: "API_KEY",
          fields: "generic_api_key,subdomain",
        },
      },
    ]);
    const seen = [
      JSON.stringify(recorded),
      await everythingStored(),
      lines,
      String(ended),
    ].join("\n");
    expect(seen).not.toContain(pipedeskKey);
  });

  it("says a key the provider rejected is rejected, leaves nothing at Composio, and keeps the key out of the error, the log and the audit; trying again with the right one connects", async () => {
    const admin = someone("admin");
    const wrongKey = `pd_${crypto.randomUUID()}`;
    const rejected = await logged(
      async () =>
        await connectWithKey(admin, {
          values: { generic_api_key: wrongKey, subdomain: "acme" },
        })
    );

    const recorded = await events();
    const seen = [
      errorText(rejected.ended),
      rejected.lines,
      JSON.stringify(recorded),
      await everythingStored(),
    ].join("\n");
    expect({
      code: connectionErrors.codeOf(rejected.ended),
      held: heldAtComposio(),
      cleanups: await cleanupsLeft(),
      recorded: recorded.map(({ action, detail }) => [action, detail]),
      keySeen: seen.includes(wrongKey),
    }).toStrictEqual({
      code: "connection.key_rejected",
      held: nothingHeld,
      cleanups: 0,
      recorded: [
        [
          "connection.connect",
          {
            provider: "pipedesk",
            scope: "shared",
            outcome: "failed",
            reason: "connection.key_rejected",
          },
        ],
      ],
      keySeen: false,
    });

    await connectWithKey(admin);
    expect(heldAtComposio()).toStrictEqual({
      authConfigs: 1,
      accounts: 1,
      servers: 1,
    });
  });

  it("takes exactly the fields Composio lists, every required one filled in, before making anything", async () => {
    const admin = someone("admin");
    const tries: Record<string, string>[] = [
      // A field Composio doesn't list, such as one it hides.
      {
        generic_api_key: pipedeskKey,
        subdomain: "acme",
        base_url: "https://evil.example",
      },
      { generic_api_key: pipedeskKey },
      { generic_api_key: pipedeskKey, subdomain: "" },
    ];
    const ends = await Promise.all(
      tries.map(
        async (values) => await outcome(connectWithKey(admin, { values }))
      )
    );
    expect(ends).toStrictEqual([
      "connection.invalid",
      "connection.invalid",
      "connection.invalid",
    ]);
    expect(composioWrites()).toStrictEqual([]);
    await expect(cleanupsLeft()).resolves.toBe(0);
  });

  it("refuses members and Grasp staff before asking Composio anything, and records it", async () => {
    const people = [someone("user"), { ...someone("admin"), staff: true }];
    const ends = await Promise.all(
      people.map(async (person) => await outcome(connectWithKey(person)))
    );
    expect(ends).toStrictEqual([
      "role.forbidden",
      "connection.staff_not_allowed",
    ]);
    expect(composio.state.requests).toStrictEqual([]);
    const refused = await events();
    expect(
      refused.map(({ detail }) => String(detail.reason)).toSorted()
    ).toStrictEqual(["connection.staff_not_allowed", "role.forbidden"]);
  });

  it("refuses a toolkit that signs in, or takes an app nobody registered, and the sign-in's consent", async () => {
    const admin = someone("admin");
    const ends = await Promise.all([
      outcome(
        connectWithKey(admin, {
          toolkit: "hubspot",
          tools: ["HUBSPOT_LIST_CONTACTS"],
        })
      ),
      outcome(
        connectWithKey(admin, {
          toolkit: "acme_erp",
          tools: ["ACME_ERP_LIST_ORDERS"],
        })
      ),
      outcome(connectWithKey(admin, { consent: composioConsentText })),
    ]);
    expect(ends).toStrictEqual([
      "connection.invalid",
      "connection.own_auth_required",
      "connection.invalid",
    ]);
    expect(composioWrites()).toStrictEqual([]);
  });

  it("deletes what it made at Composio when Composio fails midway, and records no consent", async () => {
    composio.state.failing = "POST /connected_accounts";
    await expect(outcome(connectWithKey(someone("admin")))).resolves.toBe(
      "connection.provider_refused"
    );
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
    await expect(cleanupsLeft()).resolves.toBe(0);
    const recorded = await events();
    expect(
      recorded.map(({ action, detail }) => [action, detail.reason])
    ).toStrictEqual([["connection.connect", "connection.provider_refused"]]);
  });

  it("is deleted at Composio, key and all, when disconnected", async () => {
    const admin = someone("admin");
    const connectionId = await connectWithKey(admin);
    await expect(
      exports.default.disconnect({ person: admin, connectionId })
    ).resolves.toStrictEqual({ revoked: true });
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
  });
});
