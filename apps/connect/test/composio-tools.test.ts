import { signCapability } from "@grasp-os/shared/capability";
import { composioConsentText } from "@grasp-os/shared/connect";
import type { ComposioToolRule } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { forgetComposioCatalog } from "../src/catalog.ts";
import { fakeComposioApi } from "./composio-api.ts";
import {
  addConnection,
  agentFor,
  auditEvents,
  callAs,
  chatOrigin,
  clientOrigin,
  outcome,
  someone,
} from "./connect.ts";
import type { Call } from "./connect.ts";

// The admin's allowlist for a Composio connection (threat model CN16):
// which of its tools only read, and which input property names the one
// resource a call acts on. Connect goes by it, never by what Composio's
// server declares about its own tools: a tool is a read only if the admin
// said so and Composio's catalog tags it read-only, and held to one
// resource only by the property the admin named. The ways that could fail
// come first: a server declaring a write read-only, or naming a resource
// property of its own; a read stored for a tool the catalog doesn't tag;
// an admin's rule naming a property the tool doesn't take.

/** Tools the fake classes, that Grasp never runs by their names. */
const neverTools = [
  "HUBSPOT_DELETE_COMPANY",
  "HUBSPOT_SHARE_LIST",
  "HUBSPOT_UPDATE_SETTINGS",
  "HUBSPOT_CREATE_PAYMENT",
];

/** An owner the HubSpot read fails for. */
const brokenOwner = "owner-broken";

const composio = fakeComposioApi(
  [
    {
      slug: "hubspot",
      name: "HubSpot",
      tools: [
        {
          slug: "HUBSPOT_LIST_CONTACTS",
          inputs: ["owner_id", "limit"],
          tags: ["readOnlyHint"],
        },
        {
          slug: "HUBSPOT_GET_CONTACT",
          inputs: ["contact_id"],
          tags: ["readOnlyHint"],
        },
        { slug: "HUBSPOT_CREATE_CONTACT", inputs: ["owner_id", "email"] },
        {
          slug: "HUBSPOT_LIST_SHAREHOLDERS",
          inputs: ["owner_id"],
          tags: ["readOnlyHint"],
        },
      ],
    },
    // A toolkit no list of Grasp's names: every tool as Composio serves it.
    {
      slug: "attio",
      name: "Attio",
      tools: [
        {
          slug: "ATTIO_SEARCH_RECORDS",
          inputs: ["query"],
          tags: ["readOnlyHint"],
        },
        { slug: "ATTIO_CREATE_NOTE", inputs: ["record_id", "title"] },
        { slug: "ATTIO_ASSERT_COMPANY", inputs: ["name"] },
      ],
    },
  ],
  {
    mcpTools: [
      {
        name: "ATTIO_SEARCH_RECORDS",
        readOnly: true,
        inputs: ["query"],
        run: ({ query }) => ({ output: { records: [], query } }),
      },
      {
        name: "ATTIO_CREATE_NOTE",
        inputs: ["record_id", "title"],
        run: () => ({ output: { id: "note-1" } }),
      },
      {
        name: "ATTIO_ASSERT_COMPANY",
        inputs: ["name"],
        run: () => ({ output: { id: "company-1" } }),
      },
      {
        name: "HUBSPOT_LIST_CONTACTS",
        inputs: ["owner_id", "limit"],
        run: ({ owner_id: owner }) =>
          owner === brokenOwner
            ? { output: { error: "Owner not found" }, isError: true }
            : { output: { owner, contacts: [] } },
      },
      {
        // The server says it only reads, and where its resource is.
        name: "HUBSPOT_GET_CONTACT",
        readOnly: true,
        resourceField: "contact_id",
        inputs: ["contact_id"],
        run: ({ contact_id: id }) => ({ output: { id } }),
      },
      {
        name: "HUBSPOT_CREATE_CONTACT",
        inputs: ["owner_id", "email"],
        run: () => ({ output: { id: "contact-3" } }),
      },
      // Tools the server would run, both claiming to read.
      {
        name: "HUBSPOT_UNCLASSED",
        readOnly: true,
        inputs: ["owner_id"],
        run: () => ({ output: { ran: "unclassed" } }),
      },
      {
        name: "HUBSPOT_REFUSED",
        readOnly: true,
        inputs: ["owner_id"],
        run: () => ({ output: { ran: "refused" } }),
      },
      // Tools Grasp never runs (isNeverTool), classed all the same.
      ...neverTools.map((name) => ({
        name,
        readOnly: true,
        inputs: ["owner_id"],
        run: () => ({ output: { ran: name } }),
      })),
      {
        name: "HUBSPOT_LIST_SHAREHOLDERS",
        readOnly: true,
        inputs: ["owner_id"],
        run: () => ({ output: { ran: "shareholders" } }),
      },
    ],
  }
);

const { events } = auditEvents();

/** The admin's allowlist for the connections here. */
const rules: (string | ComposioToolRule)[] = [
  { name: "HUBSPOT_LIST_CONTACTS", read: true, resource: "owner_id" },
  // Allowed by name alone: a side effect, never held to one resource.
  "HUBSPOT_GET_CONTACT",
  { name: "HUBSPOT_CREATE_CONTACT", resource: "owner_id" },
];

/** A HubSpot connection allowing `rules`, as the flow leaves it. */
const hubspot = async (): Promise<string> =>
  await addConnection({
    provider: "hubspot",
    server: `https://backend.composio.dev/v3/mcp/${crypto.randomUUID()}?connected_account_id=ca_1`,
    tools: JSON.stringify(rules),
  });

const owner = "owner-7";

/** Where a run's call comes from, as core signs it. */
const runOrigin = {
  permissionId: "permission-hubspot",
  context: {
    type: "workflowRun" as const,
    workflowId: "workflow-crm",
    runId: "run-1",
  },
};

/** An answer's output, as the JSON value it holds. */
const parsed = (text: string): unknown => JSON.parse(text);

/** A call without an idempotency key. */
const read = (
  connectionId: string,
  action: string,
  input: Call["input"] = {}
): Call => ({ connectionId, action, input });

describe("a Composio toolkit no list of Grasp's names, such as Attio", () => {
  it("lists every tool, offers and runs what its admin allowed (a read as a read, one allowed by name alone held as a change), and refuses the rest", async () => {
    const listed = await exports.default.catalogTools({
      source: "composio",
      id: "attio",
    });
    const connectionId = await addConnection({
      provider: "attio",
      server: `https://backend.composio.dev/v3/mcp/${crypto.randomUUID()}?connected_account_id=ca_attio`,
      tools: JSON.stringify([
        { name: "ATTIO_SEARCH_RECORDS", read: true },
        // Composio says nothing of what it does: allowed as a change.
        "ATTIO_ASSERT_COMPANY",
      ]),
    });
    const anna = someone();
    const inChat = agentFor(anna.userId, "agent-chat", "interactive");
    const searched = await callAs(
      inChat,
      read(connectionId, "ATTIO_SEARCH_RECORDS", { query: "Acme" }),
      { origin: chatOrigin }
    );
    const asserted = await callAs(
      inChat,
      {
        ...read(connectionId, "ATTIO_ASSERT_COMPANY", { name: "Acme" }),
        idempotencyKey: crypto.randomUUID(),
      },
      { origin: chatOrigin }
    );
    const notAllowed = await outcome(
      callAs(inChat, read(connectionId, "ATTIO_CREATE_NOTE", {}), {
        origin: chatOrigin,
      })
    );
    const connections = await exports.default.listConnections(anna);
    expect({
      listed: listed.map(({ name, readOnly }) => [name, readOnly]),
      offered: connections.find(({ id }) => id === connectionId)?.offeredTools,
      searched: searched.pending === undefined ? "ran" : "held",
      asserted: asserted.pending === undefined ? "ran" : "held",
      notAllowed,
      ran: composio.state.mcp.ran.map(({ tool }) => tool),
    }).toStrictEqual({
      // Every tool Composio serves, a read only where it says so.
      listed: [
        ["ATTIO_SEARCH_RECORDS", true],
        ["ATTIO_CREATE_NOTE", false],
        ["ATTIO_ASSERT_COMPANY", false],
      ],
      offered: ["ATTIO_SEARCH_RECORDS", "ATTIO_ASSERT_COMPANY"],
      searched: "ran",
      asserted: "held",
      notAllowed: "connect.action_not_found",
      ran: ["ATTIO_SEARCH_RECORDS"],
    });
  });
});

describe("a Composio tool stored as a read", () => {
  it("runs as a read only while Composio tags it read-only: one it doesn't, or a catalog connect can't read, holds it as a change", async () => {
    const connectionId = await addConnection({
      provider: "attio",
      server: `https://backend.composio.dev/v3/mcp/${crypto.randomUUID()}?connected_account_id=ca_attio`,
      // As a list stored before the connect form refused an untagged read.
      tools: JSON.stringify([
        { name: "ATTIO_SEARCH_RECORDS", read: true },
        { name: "ATTIO_ASSERT_COMPANY", read: true },
      ]),
    });
    const anna = someone();
    const inChat = agentFor(anna.userId, "agent-chat", "interactive");
    const ask = async (action: string) => {
      const answer = await callAs(
        inChat,
        {
          ...read(connectionId, action, { query: "Acme", name: "Acme" }),
          idempotencyKey: crypto.randomUUID(),
        },
        { origin: chatOrigin }
      );
      return answer.pending === undefined ? "ran" : "held";
    };
    const tagged = await ask("ATTIO_SEARCH_RECORDS");
    const untagged = await ask("ATTIO_ASSERT_COMPANY");
    // A new isolate, its catalog not read yet, while Composio is down.
    forgetComposioCatalog();
    composio.state.health = "down";
    const unread = await ask("ATTIO_SEARCH_RECORDS");
    expect({ tagged, untagged, unread }).toStrictEqual({
      tagged: "ran",
      untagged: "held",
      unread: "held",
    });
  });

  it("is refused when core let it through as another class than Composio's tag makes it now, so a read core took for a change never runs unpointed", async () => {
    const connectionId = await addConnection({
      provider: "attio",
      server: `https://backend.composio.dev/v3/mcp/${crypto.randomUUID()}?connected_account_id=ca_attio`,
      tools: JSON.stringify([{ name: "ATTIO_SEARCH_RECORDS", read: true }]),
    });
    const inChat = agentFor("user-anna", "agent-chat", "interactive");
    const search = read(connectionId, "ATTIO_SEARCH_RECORDS", { query: "x" });
    const as = async (toolClass: "read-company" | "change-company") =>
      await outcome(callAs(inChat, search, { origin: chatOrigin, toolClass }));
    // Core read the catalog while Composio was down: a change, no pointers.
    const takenForChange = await as("change-company");
    const asRead = await as("read-company");
    // Core read it as a read; the catalog can't be read as it runs.
    forgetComposioCatalog();
    composio.state.health = "down";
    const unreadNow = await as("read-company");
    expect({
      takenForChange,
      asRead,
      unreadNow,
      ran: composio.state.mcp.ran.map(({ tool }) => tool),
    }).toStrictEqual({
      takenForChange: "connect.class_changed",
      asRead: "ok",
      unreadNow: "connect.class_changed",
      ran: ["ATTIO_SEARCH_RECORDS"],
    });
  });
});

describe("a chat agent's read in a company app pointed at within some resources", () => {
  it("runs on those resources alone, while changes aren't bound by them", async () => {
    const connectionId = await hubspot();
    const pointed = { resources: [owner] };
    const ends = await Promise.all([
      outcome(
        callAs(
          agentFor("user-anna"),
          read(connectionId, "HUBSPOT_LIST_CONTACTS", { owner_id: owner }),
          pointed
        )
      ),
      outcome(
        callAs(
          agentFor("user-anna"),
          read(connectionId, "HUBSPOT_LIST_CONTACTS", { owner_id: "owner-9" }),
          pointed
        )
      ),
      // Not pointed at within any: the whole app.
      outcome(
        callAs(
          agentFor("user-anna"),
          read(connectionId, "HUBSPOT_LIST_CONTACTS", { owner_id: "owner-9" })
        )
      ),
      // A change waits for its person, wherever it goes.
      outcome(
        callAs(
          agentFor("user-anna", "agent-chat", "interactive"),
          {
            ...read(connectionId, "HUBSPOT_CREATE_CONTACT", {
              owner_id: "owner-9",
              email: "ben@acme.test",
            }),
            idempotencyKey: crypto.randomUUID(),
          },
          pointed
        )
      ),
    ]);
    expect(ends).toStrictEqual([
      "ok",
      "connect.resource_not_pointed",
      "ok",
      "ok",
    ]);
  });

  it("is offered with its class, for core to hold it to the company's", async () => {
    const connectionId = await hubspot();
    const [owned] = await exports.default.connectionOwners([connectionId]);
    expect(owned?.toolClasses).toStrictEqual({
      HUBSPOT_LIST_CONTACTS: "read-company",
      HUBSPOT_GET_CONTACT: "change-company",
      HUBSPOT_CREATE_CONTACT: "change-company",
    });
  });
});

describe("a Composio tool Grasp never runs", () => {
  it("is refused, neither offered nor run, even when the admin allowed it by name", async () => {
    const connectionId = await addConnection({
      provider: "hubspot",
      server: `https://backend.composio.dev/v3/mcp/${crypto.randomUUID()}?connected_account_id=ca_1`,
      tools: JSON.stringify([
        ...neverTools,
        { name: "HUBSPOT_LIST_SHAREHOLDERS", read: true },
      ]),
    });
    const requestsBefore = composio.state.mcp.requests;
    const ends = await Promise.all(
      neverTools.map(
        async (action) =>
          await outcome(
            callAs(agentFor("user-anna"), {
              ...read(connectionId, action, { owner_id: owner }),
              idempotencyKey: crypto.randomUUID(),
            })
          )
      )
    );
    const listed = await exports.default.listConnections(someone());
    const connection = listed.find(({ id }) => id === connectionId);
    expect({
      ends,
      offered: connection?.offeredTools,
      requests: composio.state.mcp.requests - requestsBefore,
      ran: composio.state.mcp.ran,
    }).toStrictEqual({
      ends: neverTools.map(() => "connect.never"),
      offered: ["HUBSPOT_LIST_SHAREHOLDERS"],
      requests: 0,
      ran: [],
    });
    // A word of the rule only inside another isn't one of its words.
    await expect(
      outcome(
        callAs(
          agentFor("user-anna"),
          read(connectionId, "HUBSPOT_LIST_SHAREHOLDERS", { owner_id: owner })
        )
      )
    ).resolves.toBe("ok");
  });
});

describe("a Composio tool the admin marked as a read", () => {
  it("runs without an idempotency key, from chat too, without waiting for anyone", async () => {
    const connectionId = await hubspot();
    const inChat = agentFor("user-anna", "agent-chat", "interactive");
    const result = await callAs(
      inChat,
      read(connectionId, "HUBSPOT_LIST_CONTACTS", { limit: "5" }),
      { origin: chatOrigin }
    );
    expect(JSON.parse(result.output)).toStrictEqual({ contacts: [] });
    const [call] = await events();
    expect(call?.detail).toMatchObject({ sideEffect: false, outcome: "ok" });
  });

  it("is held for its person in a restricted context, as a side effect: what it sends may carry that data", async () => {
    const anna = someone();
    const connectionId = await hubspot();
    const run = agentFor(anna.userId);
    const signed = { restricted: true, origin: runOrigin };
    const withoutKey = await outcome(
      callAs(run, read(connectionId, "HUBSPOT_LIST_CONTACTS"), signed)
    );
    const call = {
      ...read(connectionId, "HUBSPOT_LIST_CONTACTS", { owner_id: owner }),
      idempotencyKey: "run-1:list",
    };
    const withKey = await outcome(callAs(run, call, signed));
    const ranBefore = [...composio.state.mcp.ran];
    const [held, ...others] = await exports.default.listPendingActions(
      anna,
      "grasp"
    );
    if (held === undefined || others.length > 0) {
      throw new Error("Expected one held action");
    }
    const confirmed = await exports.default.confirmAction({
      person: anna,
      id: held.id,
      inputHash: held.inputHash,
      capability: await signCapability(env.CAPABILITY_SIGNING_KEY, run, {
        connectionId,
        action: held.action,
        idempotencyKey: held.idempotencyKey,
        ...signed,
        decision: { kind: "confirm", pendingActionId: held.id },
      }),
    });
    // The step tries again under the same key: it gets the answer, and
    // the tool doesn't run again.
    const repeat = await callAs(run, call, signed);
    const recorded = await events();
    const calls = recorded.filter(({ action }) => action === "connection.call");
    const output = { owner, contacts: [] };
    expect({
      withoutKey,
      withKey,
      ranBefore,
      confirmed: parsed(confirmed.output),
      repeat: parsed(repeat.output),
      outcomes: calls.map(({ detail }) => detail.outcome),
      ran: composio.state.mcp.ran,
    }).toStrictEqual({
      withoutKey: "connect.idempotency_key_required",
      withKey: "connect.held",
      ranBefore: [],
      confirmed: output,
      repeat: output,
      outcomes: ["refused", "held", "ok", "replayed"],
      ran: [{ tool: "HUBSPOT_LIST_CONTACTS", input: { owner_id: owner } }],
    });
  });

  it("keeps its error as the failure in a restricted context, replayed to a repeat without running again", async () => {
    const anna = someone();
    const connectionId = await hubspot();
    const run = agentFor(anna.userId);
    const signed = { restricted: true, origin: runOrigin };
    const call = {
      ...read(connectionId, "HUBSPOT_LIST_CONTACTS", { owner_id: brokenOwner }),
      idempotencyKey: "run-1:list-broken",
    };
    const withKey = await outcome(callAs(run, call, signed));
    const [held, ...others] = await exports.default.listPendingActions(
      anna,
      "grasp"
    );
    if (held === undefined || others.length > 0) {
      throw new Error("Expected one held action");
    }
    // A side effect here, but a read the admin vouched for: it can't have
    // acted, so its error is the action's failure, not an unknown outcome.
    const confirmed = await outcome(
      exports.default.confirmAction({
        person: anna,
        id: held.id,
        inputHash: held.inputHash,
        capability: await signCapability(env.CAPABILITY_SIGNING_KEY, run, {
          connectionId,
          action: held.action,
          idempotencyKey: held.idempotencyKey,
          ...signed,
          decision: { kind: "confirm", pendingActionId: held.id },
        }),
      })
    );
    const requestsBefore = composio.state.mcp.requests;
    const repeat = await outcome(callAs(run, call, signed));
    const recorded = await events();
    const calls = recorded.filter(({ action }) => action === "connection.call");
    expect({
      withKey,
      confirmed,
      repeat,
      repeatRequests: composio.state.mcp.requests - requestsBefore,
      outcomes: calls.map(({ detail }) => detail.outcome),
      ran: composio.state.mcp.ran,
    }).toStrictEqual({
      withKey: "connect.held",
      confirmed: "connect.action_failed",
      repeat: "connect.action_failed",
      repeatRequests: 0,
      outcomes: ["held", "failed", "replayed"],
      ran: [
        { tool: "HUBSPOT_LIST_CONTACTS", input: { owner_id: brokenOwner } },
      ],
    });
  });

  it("is held to one resource by the input property the admin named", async () => {
    const connectionId = await hubspot();
    const forOwner = (input: Call["input"]) => ({
      ...read(connectionId, "HUBSPOT_LIST_CONTACTS", input),
      resource: owner,
    });
    const inputs: Call["input"][] = [
      { owner_id: owner, limit: "5" },
      { owner_id: "owner-8" },
      {},
      // A property the tool's schema doesn't take.
      { owner_id: owner, ownerId: "owner-8" },
    ];
    const ends = await Promise.all(
      inputs.map(
        async (input) =>
          await outcome(callAs(agentFor("user-anna"), forOwner(input)))
      )
    );
    expect(ends).toStrictEqual([
      "ok",
      "connect.resource_out_of_scope",
      "connect.resource_out_of_scope",
      "connect.resource_out_of_scope",
    ]);
    expect(composio.state.mcp.ran).toStrictEqual([
      { tool: "HUBSPOT_LIST_CONTACTS", input: { owner_id: owner, limit: "5" } },
    ]);
  });
});

describe("a Composio tool the admin didn't mark as a read", () => {
  it("is a side effect even when its server declares it read-only", async () => {
    const connectionId = await hubspot();
    await expect(
      outcome(
        callAs(
          agentFor("user-anna"),
          read(connectionId, "HUBSPOT_GET_CONTACT", { contact_id: "c-1" })
        )
      )
    ).resolves.toBe("connect.idempotency_key_required");
    expect(composio.state.mcp.ran).toStrictEqual([]);
  });

  it("waits in chat for its person, audited as a side effect, and doesn't run", async () => {
    const anna = someone();
    const connectionId = await hubspot();
    const inChat = agentFor(anna.userId, "agent-chat", "interactive");
    const call = {
      ...read(connectionId, "HUBSPOT_GET_CONTACT", { contact_id: "c-1" }),
      idempotencyKey: crypto.randomUUID(),
    };
    const answer = await callAs(inChat, call, { origin: chatOrigin });
    const [pending] = await exports.default.listPendingActions(anna, "grasp");
    expect(answer.pending?.id).toBe(pending?.id);
    expect(pending?.action).toBe("HUBSPOT_GET_CONTACT");
    const [held] = await events();
    expect(held?.detail).toMatchObject({ sideEffect: true, outcome: "held" });
    expect(composio.state.mcp.ran).toStrictEqual([]);
  });

  it("isn't held to the resource property its server names, only to one the admin named", async () => {
    const connectionId = await hubspot();
    const call = {
      ...read(connectionId, "HUBSPOT_GET_CONTACT", { contact_id: "c-1" }),
      resource: "c-1",
      idempotencyKey: crypto.randomUUID(),
    };
    await expect(outcome(callAs(agentFor("user-anna"), call))).resolves.toBe(
      "connect.resource_out_of_scope"
    );
    // A write the admin held to a property runs for that resource only.
    const create = {
      ...read(connectionId, "HUBSPOT_CREATE_CONTACT", {
        owner_id: owner,
        email: "new@acme.test",
      }),
      resource: owner,
      idempotencyKey: crypto.randomUUID(),
    };
    await expect(outcome(callAs(agentFor("user-anna"), create))).resolves.toBe(
      "ok"
    );
    expect(composio.state.mcp.ran.map(({ tool }) => tool)).toStrictEqual([
      "HUBSPOT_CREATE_CONTACT",
    ]);
  });
});

describe("a call core signs for work that may only read", () => {
  it("reads, refuses every tool that isn't a read before it is held, run or replayed, and holds a read from a restricted context for its person", async () => {
    const anna = someone();
    const connectionId = await hubspot();
    const inChat = agentFor(anna.userId, "agent-chat", "interactive");
    const readOnly = { readOnly: true, origin: chatOrigin };
    const create = {
      ...read(connectionId, "HUBSPOT_CREATE_CONTACT", {
        owner_id: owner,
        email: "new@acme.test",
      }),
      idempotencyKey: crypto.randomUUID(),
    };
    // The same side effect, run once by work that may write: its stored
    // result isn't handed to a read under the same key either.
    const run = agentFor(anna.userId);
    const ranOnce = await outcome(callAs(run, create, { origin: runOrigin }));
    const outcomes = {
      list: await outcome(
        callAs(
          inChat,
          read(connectionId, "HUBSPOT_LIST_CONTACTS", { owner_id: owner }),
          readOnly
        )
      ),
      // In chat a side effect would be held for its person.
      held: await outcome(callAs(inChat, create, readOnly)),
      replayed: await outcome(
        callAs(run, create, { readOnly: true, origin: runOrigin })
      ),
      // A read from a restricted context is a side effect too: still a
      // read, so it waits for its person rather than being refused.
      restricted: await outcome(
        callAs(
          run,
          {
            ...read(connectionId, "HUBSPOT_LIST_CONTACTS", { owner_id: owner }),
            idempotencyKey: crypto.randomUUID(),
          },
          { readOnly: true, restricted: true, origin: runOrigin }
        )
      ),
    };
    const recorded = await events();
    const pending = await exports.default.listPendingActions(anna, "grasp");
    expect({
      ranOnce,
      outcomes,
      pending: pending.map(({ action, restricted }) => ({
        action,
        restricted,
      })),
      ran: composio.state.mcp.ran.map(({ tool }) => tool),
      audited: recorded
        .filter(({ action }) => action === "connection.call")
        .map(({ detail }) => detail.outcome),
    }).toStrictEqual({
      ranOnce: "ok",
      outcomes: {
        list: "ok",
        held: "connect.read_only",
        replayed: "connect.read_only",
        restricted: "connect.held",
      },
      pending: [{ action: "HUBSPOT_LIST_CONTACTS", restricted: true }],
      ran: ["HUBSPOT_CREATE_CONTACT", "HUBSPOT_LIST_CONTACTS"],
      audited: ["ok", "ok", "refused", "refused", "held"],
    });
  });
});

/** Starts connecting HubSpot with `tools`, for an admin. */
const start = async (
  tools: (string | ComposioToolRule)[],
  person = someone("admin")
) =>
  await exports.default.startToolkitConnection({
    person,
    toolkit: "hubspot",
    tools,
    consent: composioConsentText,
    origin: clientOrigin,
    returnTo: "/connectors",
  });

describe("the admin's allowlist, when they connect", () => {
  it("is kept with the flow, rules and all, and the log names each tool that runs unheld", async () => {
    const admin = someone("admin");
    const allowed = [
      { name: "HUBSPOT_LIST_CONTACTS", read: true },
      { name: "HUBSPOT_GET_CONTACT", read: true },
      "HUBSPOT_CREATE_CONTACT",
    ];
    const { url } = await start(allowed, admin);
    const { state } = composio.authorize(url);
    await exports.default.finishConnection({
      person: admin,
      state,
    });
    const recorded = await events();
    const counted = recorded
      .filter(({ action }) =>
        ["connection.consent", "connection.connect"].includes(action)
      )
      .map(({ action, detail }) => ({
        action,
        toolCount: detail.toolCount,
        readCount: detail.readCount,
      }));
    expect(counted).toStrictEqual([
      {
        action: "connection.consent",
        toolCount: 3,
        readCount: 2,
      },
      {
        action: "connection.connect",
        toolCount: 3,
        readCount: 2,
      },
    ]);
    const consent = recorded.find(
      ({ action }) => action === "connection.consent"
    );
    expect(
      recorded
        .filter(({ action }) => action === "connection.consent.read_tools")
        .map(({ actor, detail }) => ({ actor, detail }))
    ).toStrictEqual([
      {
        actor: consent?.actor,
        detail: {
          provider: "hubspot",
          scope: "shared",
          flowId: consent?.detail.flowId,
          part: 1,
          names1: "HUBSPOT_LIST_CONTACTS,HUBSPOT_GET_CONTACT",
        },
      },
    ]);
    expect(consent?.detail).not.toHaveProperty("unnamedReadCount");
  });

  it("names only the tools' own input properties as resources, and each tool once", async () => {
    const refused = [
      [{ name: "HUBSPOT_GET_CONTACT", read: true, resource: "owner_id" }],
      [{ name: "HUBSPOT_GET_CONTACT", resource: "contact.id" }],
      [{ name: "HUBSPOT_EXPORT", read: true }],
      ["HUBSPOT_GET_CONTACT", { name: "HUBSPOT_GET_CONTACT", read: true }],
    ];
    const ends = await Promise.all(
      refused.map(async (tools) => await outcome(start(tools)))
    );
    expect(ends).toStrictEqual(refused.map(() => "connection.invalid"));
    expect(
      composio.state.requests.filter(({ method }) => method !== "GET")
    ).toStrictEqual([]);
  });

  it("gives Composio's server the allowed tools by name", async () => {
    const admin = someone("admin");
    const { url } = await start(rules, admin);
    const { state } = composio.authorize(url);
    await exports.default.finishConnection({
      person: admin,
      state,
    });
    const [server] = composio.state.holds.servers.values();
    expect(server?.allowedTools).toStrictEqual([
      "HUBSPOT_LIST_CONTACTS",
      "HUBSPOT_GET_CONTACT",
      "HUBSPOT_CREATE_CONTACT",
    ]);
  });
});
