import {
  generatedContracts,
  readsMailByRules,
} from "@grasp-os/runtime/connector";
import {
  actionShapeRequestSchema,
  connectErrors,
  connectionToolsRequestSchema,
  connectorContractRequestSchema,
  connectorContractsRequestSchema,
  nativeOperationRequestSchema,
} from "@grasp-os/shared/connect";
import type {
  ActionShape,
  ConnectionTool,
  ConnectorContract,
  ConnectorContractAction,
  NativeOperation,
} from "@grasp-os/shared/connect";
import {
  httpActionSchemas,
  httpActions,
} from "@grasp-os/shared/http-connections";
import { httpContract } from "@grasp-os/shared/http-contract";
import { canonicalJson, isRecord } from "@grasp-os/shared/json";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { nativeConnector, nativeConnectors } from "./bundled-connectors.ts";
import {
  composioContract,
  composioContractPrefix,
} from "./composio-contracts.ts";
import { allowedTool } from "./connections.ts";
import type { Connection } from "./connections.ts";
import { connections } from "./db/schema.ts";
import {
  httpConfigOf,
  httpServedContract,
  httpTool,
} from "./http-connections.ts";
import {
  connectorActionShape,
  connectorContractId,
  connectorContract as connectorServedContract,
  keptToolsNow,
  offeredTools,
} from "./mcp-connectors.ts";

// Generated connector contracts (spec 12). Which one a connection serves
// is decided by the connection's kind, never by the name alone, so a
// toolkit named like one of our connectors, or a connector named like
// Composio, never serves the other's contract:
//
// - a native connection serves its connector's actions of one family, such
//   as its `mail.*` tools, as `<connector>.<family>@1`, with the JSON
//   Schemas the connector's own schemas make of each action's input and
//   output (runtime/connector's manifest, `generatedContracts`). Read from the
//   release's manifests alone: nothing is loaded and no token is read;
// - a Composio connection serves `composio.<toolkit>@1`, its own toolkit's
//   allowed tools, as its server lists them now (composio-contracts.ts);
// - a connection to a connector made from a URL serves
//   `connector.<connector>@1`, its server's tools as it lists them now,
//   each with its class by the rules (mcp-connectors.ts);
// - an HTTP connection serves `http.request@1` (GRA-1478): `get` and
//   `send`, those its allowed methods use, with schemas of connect's own
//   (`httpActionSchemas`). What it may reach is the connection's, checked
//   on every call (http-connections.ts), never the contract's.
//
// Core binds an App's connector resource to one, checks every call's input
// and answer against it, and fingerprints it, so a change to any of it (a
// connector release, Composio changing a tool) stops the binding until an
// admin approves it again. No contract describes what the connection
// can't do.

/** A native connection's contract `contract`, if its connector serves it. */
const nativeContract = (
  connection: Connection,
  contract: string
): ConnectorContract | undefined => {
  const name = contract.slice(0, contract.indexOf("."));
  const connector =
    name === composioContractPrefix ? undefined : nativeConnector(name);
  const served =
    connector === undefined
      ? undefined
      : generatedContracts(connector.manifest).get(contract);
  if (
    served === undefined ||
    connection.serverKind !== "native" ||
    connection.server !== name ||
    connector?.manifest.provider !== connection.provider
  ) {
    return undefined;
  }
  const actions: Record<string, ConnectorContractAction> = {};
  for (const [action, { tool, declared }] of served) {
    actions[action] = {
      tool,
      readOnly: declared.readOnly,
      input: JSON.stringify(declared.contract.input),
      output: JSON.stringify(declared.contract.output),
      ...(declared.answersFile === true ? { answersFile: true as const } : {}),
      ...(declared.takesFiles === true ? { takesFiles: true as const } : {}),
    };
  }
  return { contract, actions };
};

/**
 * The contract `request` names, as its connection serves it now; or
 * `connect.contract_not_found`, or `connect.server_unavailable` when a
 * Composio connection's server can't be reached to read it.
 */
export const connectorContract = async (
  env: Env,
  request: unknown
): Promise<ConnectorContract> => {
  const parsed = connectorContractRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { contract, connectionId } = parsed.data;
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (connection === undefined || connection.status === "disconnected") {
    throw connectErrors.create("connect.contract_not_found");
  }
  if (connection.serverKind === "composio") {
    if (contract !== `${composioContractPrefix}.${connection.provider}@1`) {
      throw connectErrors.create("connect.contract_not_found");
    }
    return await composioContract(env, connection, contract);
  }
  if (connection.serverKind === "connector") {
    if (contract !== connectorContractId(connection.server)) {
      throw connectErrors.create("connect.contract_not_found");
    }
    return await connectorServedContract(env, connection);
  }
  if (connection.serverKind === "http") {
    const config = await httpConfigOf(env, connection.id);
    if (contract !== httpContract || config === undefined) {
      throw connectErrors.create("connect.contract_not_found");
    }
    return httpServedContract(config);
  }
  const served = nativeContract(connection, contract);
  if (served === undefined) {
    throw connectErrors.create("connect.contract_not_found");
  }
  return served;
};

/**
 * The IDs of the contracts `request`'s connection could serve, by its kind
 * as `connectorContract` decides it: what an admin is offered to bind a
 * workflow's connector binding to, each read as it is served when it is
 * offered and again when it is approved.
 */
export const connectorContracts = async (
  env: Env,
  request: unknown
): Promise<string[]> => {
  const parsed = connectorContractsRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, parsed.data.connectionId))
    .get();
  if (connection === undefined || connection.status === "disconnected") {
    return [];
  }
  if (connection.serverKind === "composio") {
    return [`${composioContractPrefix}.${connection.provider}@1`];
  }
  if (connection.serverKind === "http") {
    return (await httpConfigOf(env, connection.id)) === undefined
      ? []
      : [httpContract];
  }
  if (connection.serverKind === "connector") {
    return [connectorContractId(connection.server)];
  }
  const connector =
    connection.server === composioContractPrefix
      ? undefined
      : nativeConnector(connection.server);
  if (
    connection.serverKind !== "native" ||
    connector?.manifest.provider !== connection.provider
  ) {
    return [];
  }
  return [...generatedContracts(connector.manifest).keys()];
};

/** Most characters of a tool's description a search reads: its start. */
const searchedChars = 500;

/** The keys of a JSON Schema a search's one-line input type is written from. */
const outlineKeys: ReadonlySet<string> = new Set([
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "items",
  "additionalProperties",
  "anyOf",
  "oneOf",
]);

/**
 * What a search shows of an input schema (core's tool-search.ts): its
 * types `levels` schemas deep, without descriptions or anything else, so
 * a connector of thousands of tools hands each search a small answer.
 */
const outlineOf = (schema: unknown, levels: number): unknown => {
  if (!isRecord(schema)) {
    return schema;
  }
  if (levels === 0) {
    return {};
  }
  const inner = (each: unknown): unknown => outlineOf(each, levels - 1);
  const outlined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!outlineKeys.has(key)) {
      continue;
    }
    if (key === "properties" && isRecord(value)) {
      outlined[key] = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [name, inner(property)])
      );
    } else if (key === "items" || key === "additionalProperties") {
      outlined[key] = inner(value);
    } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      // A union's members are the schema's own level, as its type is.
      outlined[key] = value.map((each) => outlineOf(each, levels));
    } else {
      outlined[key] = value;
    }
  }
  return outlined;
};

/**
 * A connection's tools with their descriptions and schemas: a native
 * connection's from its connector's manifest, a connector's from its
 * server's list; none of any other.
 */
const describedTools = async (
  env: Env,
  connection: Connection,
  searched: ((work: Promise<unknown>) => void) | undefined
): Promise<
  { name: string; description: string; input: unknown; output: unknown }[]
> => {
  if (connection.serverKind === "connector") {
    const listed =
      searched === undefined
        ? await offeredTools(env, connection)
        : await keptToolsNow(env, connection, searched);
    return listed.map(({ name, description, inputSchema, outputSchema }) => ({
      name,
      description: description ?? "",
      input: inputSchema,
      output: outputSchema,
    }));
  }
  const manifest =
    connection.serverKind === "native"
      ? nativeConnector(connection.server)?.manifest
      : undefined;
  if (manifest?.provider !== connection.provider) {
    return [];
  }
  return Object.entries(manifest.actions).map(
    ([name, { description, contract }]) => ({
      name,
      description,
      input: contract.input,
      output: contract.output,
    })
  );
};

/**
 * The tools a call of `request`'s connection may name, with their
 * descriptions and schemas (`ConnectionTool`): a native connection's as
 * its connector's manifest in this release has them; a connector's, in
 * full for the `actions` named, as its server lists them now
 * (`offeredTools`), else every one as a search reads it, as kept and at
 * once, a stale list read again after (`later`); never one an admin
 * blocked on its connector. None for any other
 * connection, or one that is gone. Throws `connect.server_unavailable`
 * when a connector's list can't be read for the `actions` named.
 */
export const connectionTools = async (
  env: Env,
  request: unknown,
  later: (work: Promise<unknown>) => void
): Promise<ConnectionTool[]> => {
  const parsed = connectionToolsRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, parsed.data.connectionId))
    .get();
  if (connection === undefined || connection.status === "disconnected") {
    return [];
  }
  const { actions } = parsed.data;
  const tools = await describedTools(
    env,
    connection,
    actions === undefined ? later : undefined
  );
  if (actions !== undefined) {
    return tools
      .filter(({ name }) => actions.includes(name))
      .map(({ name, description, input, output }) => ({
        name,
        description,
        input: JSON.stringify(input),
        output: output === undefined ? null : JSON.stringify(output),
      }));
  }
  return tools.map(({ name, description, input }) => ({
    name,
    // A character the cut splits reads U+FFFD.
    description: description.slice(0, searchedChars).toWellFormed(),
    input: JSON.stringify(outlineOf(input, 3)),
    output: null,
  }));
};

/** The properties a served JSON Schema names, or `null` for none it can tell. */
const propertiesOf = (schema: string | undefined): string[] | null => {
  if (schema === undefined) {
    return null;
  }
  const parsed: unknown = JSON.parse(schema);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const properties: unknown = Reflect.get(parsed, "properties");
  return typeof properties === "object" && properties !== null
    ? Object.keys(properties)
    : [];
};

/**
 * What core needs of a Composio connection's `action`: a read only as its
 * admin allowed it, with the input its server lists now, and mail as the
 * rules read a read's name (`readsMailByRules`), as for any server's.
 */
const composioActionShape = async (
  env: Env,
  connection: Connection,
  action: string
): Promise<ActionShape> => {
  const { provider } = connection;
  const rule = allowedTool(connection, action);
  if (rule === undefined) {
    throw connectErrors.create("connect.action_not_found");
  }
  let inputs: string[] | null = null;
  try {
    const served = await composioContract(
      env,
      connection,
      `${composioContractPrefix}.${provider}@1`
    );
    inputs = propertiesOf(
      Object.hasOwn(served.actions, action)
        ? served.actions[action]?.input
        : undefined
    );
  } catch (error) {
    // No tool of it can be served as a contract: its input is unknown.
    if (connectErrors.codeOf(error) !== "connect.contract_not_found") {
      throw error;
    }
  }
  return {
    readOnly: rule.read,
    inputs,
    provider,
    // As a read of a server connected by its URL: by the rules.
    ...(rule.read && readsMailByRules(action, provider)
      ? { mail: true as const }
      : {}),
  };
};

/**
 * What core needs of `request`'s action before a chat's agent calls it
 * (`ActionShape`), by the same rules a call goes by: a Composio tool is a
 * read only as its admin allowed it, with the input its server lists now;
 * a native one as its manifest says. `connect.action_not_found` for an
 * action the connection doesn't allow, `connect.server_unavailable` when
 * a Composio server can't be reached to list its tools.
 */
export const actionShape = async (
  env: Env,
  request: unknown
): Promise<ActionShape> => {
  const parsed = actionShapeRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { connectionId, action } = parsed.data;
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (connection === undefined || connection.status === "disconnected") {
    throw connectErrors.create("connect.connection_not_found");
  }
  const { provider } = connection;
  if (connection.serverKind === "composio") {
    return await composioActionShape(env, connection, action);
  }
  if (connection.serverKind === "connector") {
    return await connectorActionShape(env, connection, action);
  }
  if (connection.serverKind === "http") {
    const config = await httpConfigOf(env, connection.id);
    const tool = config === undefined ? undefined : httpTool(config, action);
    if (tool === undefined) {
      throw connectErrors.create("connect.action_not_found");
    }
    return {
      readOnly: tool.readOnly,
      inputs: [...(tool.inputProperties ?? [])],
      provider,
    };
  }
  const manifest = nativeConnector(connection.server)?.manifest;
  const declared =
    manifest !== undefined &&
    manifest.provider === provider &&
    Object.hasOwn(manifest.actions, action)
      ? manifest.actions[action]
      : undefined;
  if (declared === undefined) {
    throw connectErrors.create("connect.action_not_found");
  }
  return {
    readOnly: declared.readOnly,
    inputs: [...declared.input],
    provider,
    ...(declared.mail === undefined ? {} : { mail: true as const }),
  };
};

/** `text` (JSON) canonically, or undefined if it isn't JSON. */
const canonicalOf = (text: string): string | undefined => {
  try {
    const parsed = z.json().safeParse(JSON.parse(text));
    return parsed.success ? canonicalJson(parsed.data) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The native action of this release `request` describes exactly (GRA-982):
 * its tool, and the input and output JSON Schemas its connector generates,
 * canonically equal. What lets a host catalog contract carry a schema with
 * patterns: only ones a connector reviewed in this repository makes. Read
 * from the manifests alone; a Composio tool never qualifies.
 */
export const nativeOperation = (request: unknown): NativeOperation => {
  const parsed = nativeOperationRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { tool } = parsed.data;
  const input = canonicalOf(parsed.data.input);
  const output = canonicalOf(parsed.data.output);
  if (input !== undefined && output !== undefined) {
    // An HTTP connection's actions: connect's own schemas, reviewed here,
    // with no pattern.
    for (const action of httpActions) {
      const schemas = httpActionSchemas[action];
      if (
        action === tool &&
        canonicalJson(schemas.input) === input &&
        canonicalJson(schemas.output) === output
      ) {
        return { contract: httpContract, readOnly: action === "get" };
      }
    }
    for (const { manifest } of nativeConnectors()) {
      for (const [contract, served] of generatedContracts(manifest)) {
        for (const action of served.values()) {
          if (
            action.tool === tool &&
            canonicalJson(action.declared.contract.input) === input &&
            canonicalJson(action.declared.contract.output) === output
          ) {
            return {
              contract,
              readOnly: action.declared.readOnly,
              ...(action.declared.answersFile === true
                ? { answersFile: true as const }
                : {}),
              ...(action.declared.takesFiles === true
                ? { takesFiles: true as const }
                : {}),
            };
          }
        }
      }
    }
  }
  throw connectErrors.create("connect.contract_not_found");
};
