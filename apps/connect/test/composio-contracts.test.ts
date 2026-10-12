import { composioToolsMax } from "@grasp-os/shared/connect";
import type { ComposioToolRule } from "@grasp-os/shared/connect";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { fakeComposioApi } from "./composio-api.ts";
import { addConnection, connectWith, outcome } from "./connect.ts";
import type { FakeTool } from "./mcp-server.ts";
import { testComposioKey } from "./provider-config.ts";

// A Composio connection's generated contract, `composio.<toolkit>@1`
// (threat model on GRA-504). Composio's server is untrusted and changes
// without a release of ours, so the ways it can go wrong come first:
// - a tool its admin didn't allow, or a hint that a write only reads;
// - a schema Composio changed since the last time it was read;
// - a schema too large or too deep, or a tool no App could name;
// - a toolkit, or a connection of another kind, posing as another's;
// - the server's URL, account or connect's key leaking into the contract.

const listInput = {
  type: "object",
  properties: { limit: { type: "integer", minimum: 1 } },
  required: [],
};

/** A schema of arrays `depth` deep, of strings. */
const nested = (depth: number): unknown => {
  let schema: unknown = { type: "string" };
  for (let level = 0; level < depth; level += 1) {
    schema = { type: "array", items: schema };
  }
  return schema;
};

/** How deep `HUBSPOT_ABYSS`'s schema nests: deep enough to overflow a stack. */
const abyssDepth = 100_000;

/** The tools Composio's servers have, as they list them now. */
const tools: FakeTool[] = [
  {
    name: "HUBSPOT_LIST_CONTACTS",
    inputSchema: listInput,
    outputSchema: {
      type: "object",
      properties: { contacts: { type: "array", items: { type: "string" } } },
      required: ["contacts"],
    },
    run: () => ({ output: { contacts: [] } }),
  },
  {
    // The server says it only reads: the admin didn't.
    name: "HUBSPOT_CREATE_CONTACT",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
    },
    run: () => ({ output: { id: "contact-1" } }),
  },
  {
    name: "HUBSPOT_DELETE_CONTACTS",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: () => ({ output: { deleted: 0 } }),
  },
  {
    name: "HUBSPOT_HUGE",
    inputSchema: {
      type: "object",
      description: "x".repeat(70 * 1024),
      properties: {},
    },
    run: () => ({ output: {} }),
  },
  {
    // 32 schemas deep, as deep as core reads.
    name: "HUBSPOT_DEEP_32",
    inputSchema: nested(31),
    run: () => ({ output: {} }),
  },
  {
    name: "HUBSPOT_DEEP_33",
    inputSchema: nested(32),
    run: () => ({ output: {} }),
  },
  {
    // So deep that reading it by recursion would overflow the stack.
    name: "HUBSPOT_ABYSS",
    inputSchemaText: `${"[".repeat(abyssDepth)}${"]".repeat(abyssDepth)}`,
    run: () => ({ output: {} }),
  },
  {
    name: "HUBSPOT.DOTTED",
    inputSchema: { type: "object", properties: {} },
    run: () => ({ output: {} }),
  },
  {
    // A regular expression that backtracks: core would run it.
    name: "HUBSPOT_PATTERN",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", pattern: "^(a+)+$" } },
    },
    run: () => ({ output: {} }),
  },
  {
    name: "HUBSPOT_DEEP_PATTERN",
    inputSchema: {
      type: "object",
      properties: {
        filters: {
          type: "array",
          items: { anyOf: [{ type: "string", pattern: "^(a|a)*$" }] },
        },
      },
    },
    run: () => ({ output: {} }),
  },
  {
    name: "HUBSPOT_PATTERN_ANSWER",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: { id: { type: "string", pattern: "^(a+)+$" } },
    },
    run: () => ({ output: {} }),
  },
  {
    // A field named `pattern` is data, not a regular expression.
    name: "HUBSPOT_SEARCH",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" } },
    },
    run: () => ({ output: {} }),
  },
  {
    // Its server lists it twice: which one a call would reach is unknown.
    name: "HUBSPOT_TWICE",
    inputSchema: { type: "object", properties: {} },
    alsoListedAs: ["HUBSPOT_TWICE"],
    run: () => ({ output: {} }),
  },
  {
    name: "HUBSPOT_PROTO",
    inputSchema: {
      type: "object",
      properties: {
        ["__proto__"]: { type: "string" },
        name: { type: "string" },
      },
    },
    run: () => ({ output: {} }),
  },
];

const composio = fakeComposioApi([], { mcpTools: tools });

/** The admin's allowlist: everything but `HUBSPOT_DELETE_CONTACTS`. */
const rules: (string | ComposioToolRule)[] = [
  { name: "HUBSPOT_LIST_CONTACTS", read: true },
  "HUBSPOT_CREATE_CONTACT",
  "HUBSPOT_HUGE",
  "HUBSPOT_DEEP_32",
  "HUBSPOT_DEEP_33",
  "HUBSPOT_ABYSS",
  "HUBSPOT.DOTTED",
  "HUBSPOT_PATTERN",
  "HUBSPOT_DEEP_PATTERN",
  "HUBSPOT_PATTERN_ANSWER",
  "HUBSPOT_SEARCH",
  "HUBSPOT_TWICE",
  "HUBSPOT_PROTO",
];

/** The tools above that can't be served. */
const unservable = [
  "HUBSPOT_HUGE",
  "HUBSPOT_DEEP_33",
  "HUBSPOT_ABYSS",
  "HUBSPOT.DOTTED",
  "HUBSPOT_PATTERN",
  "HUBSPOT_DEEP_PATTERN",
  "HUBSPOT_PATTERN_ANSWER",
  "HUBSPOT_TWICE",
];

/** A connected account's ID at Composio, and the server URL for it. */
const composioAccount = () => {
  const accountId = `ca_${crypto.randomUUID()}`;
  return {
    accountId,
    server: `https://backend.composio.dev/v3/mcp/${crypto.randomUUID()}?connected_account_id=${accountId}`,
  };
};

/** A HubSpot connection, as the flow leaves it, allowing `allowed`. */
const hubspot = async (
  allowed: (string | ComposioToolRule)[] = rules,
  fields: Parameters<typeof addConnection>[0] = {}
): Promise<string> =>
  await addConnection({
    provider: "hubspot",
    ...composioAccount(),
    tools: JSON.stringify(allowed),
    ...fields,
  });

const contractOf = async (
  connectionId: string,
  contract = "composio.hubspot@1"
) => await exports.default.connectorContract({ contract, connectionId });

/** A served schema, as the JSON it holds. */
const parsed = (text: string | undefined): unknown =>
  text === undefined ? undefined : JSON.parse(text);

describe("a Composio connection's generated contract", () => {
  beforeEach(() => {
    // The list tool as its server first lists it: tests change it.
    const [list] = tools;
    if (list !== undefined) {
      list.inputSchema = listInput;
      list.alsoListedAs = undefined;
    }
  });

  it("serves the tools its admin allowed, read-only only as the admin said, closed to the fields they name", async () => {
    const served = await contractOf(
      await hubspot([
        { name: "HUBSPOT_LIST_CONTACTS", read: true },
        "HUBSPOT_CREATE_CONTACT",
      ])
    );
    const { HUBSPOT_LIST_CONTACTS: list, HUBSPOT_CREATE_CONTACT: create } =
      served.actions;
    expect({
      contract: served.contract,
      actions: Object.keys(served.actions).toSorted(),
      readOnly: [list?.readOnly, create?.readOnly],
      listInput: parsed(list?.input),
      listOutput: parsed(list?.output),
      // No output schema: the tool answers its text.
      createOutput: parsed(create?.output),
    }).toStrictEqual({
      contract: "composio.hubspot@1",
      actions: ["HUBSPOT_CREATE_CONTACT", "HUBSPOT_LIST_CONTACTS"],
      readOnly: [true, false],
      listInput: { ...listInput, additionalProperties: false },
      listOutput: {
        type: "object",
        properties: { contacts: { type: "array", items: { type: "string" } } },
        required: ["contacts"],
        additionalProperties: false,
      },
      createOutput: { type: "string" },
    });
  });

  it("serves what Composio's server lists now: a tool it changed is a changed contract", async () => {
    const connectionId = await hubspot();
    const before = await contractOf(connectionId);
    const [list] = tools;
    if (list === undefined) {
      throw new Error("Expected the list tool");
    }
    list.inputSchema = {
      ...listInput,
      properties: { ...listInput.properties, archived: { type: "boolean" } },
    };
    const after = await contractOf(connectionId);
    expect(parsed(after.actions.HUBSPOT_LIST_CONTACTS?.input)).toStrictEqual({
      ...listInput,
      properties: { ...listInput.properties, archived: { type: "boolean" } },
      additionalProperties: false,
    });
    expect(after.actions.HUBSPOT_LIST_CONTACTS?.input).not.toBe(
      before.actions.HUBSPOT_LIST_CONTACTS?.input
    );
  });

  it("follows the admin's allowlist as it stands: a tool taken off it is gone", async () => {
    const connectionId = await hubspot([
      { name: "HUBSPOT_LIST_CONTACTS", read: true },
    ]);
    const served = await contractOf(connectionId);
    expect(Object.keys(served.actions)).toStrictEqual([
      "HUBSPOT_LIST_CONTACTS",
    ]);
  });

  it("leaves out what can't be served: too large or deep, a pattern anywhere, a name listed twice or no App could name", async () => {
    const served = await contractOf(await hubspot());
    const onlyUnservable = await hubspot(unservable);
    expect({
      served: Object.keys(served.actions).toSorted(),
      nothingLeft: await outcome(contractOf(onlyUnservable)),
    }).toStrictEqual({
      served: [
        "HUBSPOT_CREATE_CONTACT",
        "HUBSPOT_DEEP_32",
        "HUBSPOT_LIST_CONTACTS",
        "HUBSPOT_PROTO",
        "HUBSPOT_SEARCH",
      ],
      nothingLeft: "connect.contract_not_found",
    });
  });

  it("serves a property named `__proto__` as a property, closed like any other", async () => {
    const served = await contractOf(await hubspot(["HUBSPOT_PROTO"]));
    // Read as JSON.parse reads it, with no schema that could take
    // `__proto__` for a prototype on the way.
    const input = parsed(served.actions.HUBSPOT_PROTO?.input);
    const shape =
      typeof input === "object" &&
      input !== null &&
      "properties" in input &&
      typeof input.properties === "object" &&
      input.properties !== null &&
      "additionalProperties" in input
        ? {
            names: Object.keys(input.properties).toSorted(),
            closed: input.additionalProperties,
          }
        : undefined;
    expect(shape).toStrictEqual({
      names: ["__proto__", "name"],
      closed: false,
    });
  });

  it("isn't read from a server that lists more tools than an admin could allow twice over", async () => {
    const connectionId = await hubspot();
    const [list] = tools;
    if (list === undefined) {
      throw new Error("Expected the list tool");
    }
    list.alsoListedAs = Array.from(
      { length: 2 * composioToolsMax },
      (_, index) => `HUBSPOT_COPY_${index}`
    );
    await expect(outcome(contractOf(connectionId))).resolves.toBe(
      "connect.server_unavailable"
    );
  });

  it("is served only by a Composio connection of that very toolkit, and never stands in for a native contract", async () => {
    const connectionId = await hubspot();
    const native = await addConnection({
      provider: "microsoft",
      serverKind: "native",
      server: "microsoft-365",
    });
    const lookalike = await hubspot(rules, { provider: "microsoft-365" });
    // A native connector named like Composio's contracts
    // (test/fixtures/composio-named-connector.ts).
    const composioNamed = await addConnection({
      provider: "microsoft",
      serverKind: "native",
      server: "composio",
    });
    expect({
      otherToolkit: await outcome(
        contractOf(connectionId, "composio.salesforce@1")
      ),
      otherVersion: await outcome(
        contractOf(connectionId, "composio.hubspot@2")
      ),
      nativeContract: await outcome(
        contractOf(connectionId, "microsoft-365.mail@1")
      ),
      nativeAsComposio: await outcome(
        contractOf(native, "composio.microsoft@1")
      ),
      composioNamedNative: await outcome(
        contractOf(composioNamed, "composio.items@1")
      ),
      toolkitAsNative: await outcome(
        contractOf(lookalike, "microsoft-365.mail@1")
      ),
      nativeStill: await outcome(contractOf(native, "microsoft-365.mail@1")),
    }).toStrictEqual({
      otherToolkit: "connect.contract_not_found",
      otherVersion: "connect.contract_not_found",
      nativeContract: "connect.contract_not_found",
      nativeAsComposio: "connect.contract_not_found",
      composioNamedNative: "connect.contract_not_found",
      toolkitAsNative: "connect.contract_not_found",
      nativeStill: "ok",
    });
  });

  it("holds tool names and schemas only: no server URL, account or key", async () => {
    const { accountId, server } = composioAccount();
    const connectionId = await hubspot(rules, { accountId, server });
    const text = JSON.stringify(await contractOf(connectionId));
    expect(
      [server, new URL(server).pathname, accountId, testComposioKey].filter(
        (secret) => text.includes(secret)
      )
    ).toStrictEqual([]);
    expect(composio.state.mcp.unkeyed).toBe(0);
  });

  it("is served by no connection that's gone, and not while connect can't reach Composio", async () => {
    const live = await hubspot();
    const gone = await hubspot(rules, { status: "disconnected" });
    const withoutKey = connectWith({ COMPOSIO_API_KEY: undefined });
    expect({
      gone: await outcome(contractOf(gone)),
      withoutKey: await outcome(
        withoutKey.connectorContract({
          contract: "composio.hubspot@1",
          connectionId: live,
        })
      ),
    }).toStrictEqual({
      gone: "connect.contract_not_found",
      withoutKey: "connect.server_unavailable",
    });
  });
});
