import type { ConnectorProvider } from "@grasp-os/shared/connect";
import { isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { z } from "zod";

import {
  attachmentsMetaKey,
  confirmedMetaKey,
  connectorManifestSchema,
  effectAbsentMetaKey,
  effectKeyMetaKey,
  effectKeyPattern,
  findMetaKey,
  mcpProtocolVersion,
  notPerformedMetaKey,
  outcomeUnknownMetaKey,
  stampMetaKey,
  stampPattern,
  syncMethod,
  syncParamsSchema,
  syncPlacesMethod,
  syncPlacesParamsSchema,
} from "./manifest.ts";
import type {
  ActionManifest,
  ConnectorManifest,
  RecoveryMode,
} from "./manifest.ts";
import type { SignInInput } from "./sign-in.ts";
import type { Sync } from "./sync.ts";

// The MCP server a connector becomes in its isolate: its tools, each with
// what connect decides by (`action`), how `tools/list` describes it and
// how a call of it runs; and the errors, effect keys and recovery every
// tool shares, however its connector was written.
//
// A connector reaches its provider with plain `fetch`. The isolate's only
// way out is connect's egress handler, which adds the connection's token
// and lets through only the requests the called tool declares: the token
// is never in the isolate, and nothing else is reachable (threat model R9).
// A fresh isolate serves each call, but code must still keep nothing in
// module state: it would be a bug the day that changes.

/** What a tool returns: its output, and the IDs of what it read. */
export interface ToolResult<Output> {
  output: Output;
  /** The provider's IDs of the resources the output came from. */
  provenance?: readonly string[];
  /**
   * What a write changed, before and after, for the audit record of old
   * and new values (`changeMetaKey`).
   */
  change?: ToolChange;
}

/** What a write changed: the values before it, and after it. */
export interface ToolChange {
  before: Json;
  after: Json;
}

/** What went wrong in a tool's error, for code to act on. */
export type ToolErrorCode =
  | "invalid"
  | "egress_refused"
  | "egress_failed"
  | "throttled"
  | "unavailable"
  | "access_denied"
  | "not_found"
  | "failed"
  | "too_large"
  | "not_text"
  | "not_a_file"
  | "conflict";

/** What a caller may act on in a tool's error, besides its message. */
export interface ToolErrorDetails {
  /** What went wrong, for code to act on, such as `throttled`. */
  code: ToolErrorCode;
  /** How long the provider asks callers to wait before trying again. */
  retryAfterSeconds?: number;
}

/** The code for a call that isn't valid: the tool or the provider refused its input. */
export const invalidCode: ToolErrorCode = "invalid";

/**
 * An error whose message the caller may see, such as "No such message",
 * maybe with a code for callers to act on (`code`, `retryAfterSeconds`).
 * Any other error is reported as the action having failed.
 *
 * `notPerformed: true` says the tool did nothing at all, so it may be
 * tried again with the same idempotency key (`notPerformedMetaKey`): say,
 * the provider answered 429 to the tool's first and only write. Set it
 * only when that is certain. A write that may have reached the provider
 * (a timeout, a 5xx after sending) is not that, and neither is any failure
 * after an earlier write of the same call went through. `providerFetch`
 * sets it for a 429, and a 503 to a read, only because each tool sends at
 * most one write, as its last request; a tool that writes twice can't rely
 * on it. A read-only tool changes nothing, so it may set it for any
 * failure trying again may fix, such as a provider's 5xx.
 *
 * `outcomeUnknown: true` says the opposite: the tool's write may have
 * reached the provider, and the tool can't tell whether it took effect
 * (`outcomeUnknownMetaKey`): a dropped connection, a 5xx or a timeout
 * after it was sent, an answer to it the tool can't read. `providerFetch`
 * sets it for each of those answers to a write. Connect then never sends
 * the call again under its key, and never passes the error off as the
 * action's failure. An error can't say both.
 */
export class ToolError extends Error {
  readonly details: ToolErrorDetails | undefined;
  readonly notPerformed: boolean;
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    {
      notPerformed = false,
      outcomeUnknown = false,
      code,
      retryAfterSeconds,
    }: Partial<ToolErrorDetails> & {
      notPerformed?: boolean;
      outcomeUnknown?: boolean;
    } = {}
  ) {
    super(message);
    if (notPerformed && outcomeUnknown) {
      throw new Error(
        "A tool error can't say both that nothing was done and that its outcome is unknown"
      );
    }
    this.name = "ToolError";
    this.notPerformed = notPerformed;
    this.outcomeUnknown = outcomeUnknown;
    this.details =
      code === undefined
        ? undefined
        : {
            code,
            ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
          };
  }
}

/** A JSON object, as MCP messages carry them. */
export type JsonObject = Record<string, unknown>;

/** A `tools/call` result, as MCP has it. */
export interface CallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: JsonObject;
  isError?: boolean;
  _meta?: JsonObject;
}

/** A tool, as the server lists and calls it. */
export interface Tool {
  name: string;
  /** What connect decides the tool's calls by, before running any. */
  action: ActionManifest;
  /** As `tools/list` describes it. */
  description: JsonObject;
  /** Calls it with `args`, and the call's `_meta` as connect sent it. */
  call: (args: unknown, meta?: unknown) => Promise<CallResult>;
}

/** What connect sends beside a call's input, in its `_meta`. */
export interface CallMeta {
  /** Its effect key (`effectKeyMetaKey`), for a side effect; null otherwise. */
  key: string | null;
  /** The stamp of a workflow run's mail (`stampMetaKey`); null otherwise. */
  stamp: string | null;
  /** Whether its person confirmed it, on a card that showed its input. */
  confirmed: boolean;
  /** Whether to look its effect up instead of carrying it out. */
  find: boolean;
  /** The files' bytes as sent (base64 by digest), unchecked. */
  attachments: unknown;
}

/**
 * What a call's `_meta` asks: its effect key, its stamp, whether its
 * person confirmed it, and whether to find it.
 */
export const callMetaOf = (meta: unknown): CallMeta => {
  if (typeof meta !== "object" || meta === null) {
    return {
      key: null,
      stamp: null,
      confirmed: false,
      find: false,
      attachments: undefined,
    };
  }
  const key: unknown = Reflect.get(meta, effectKeyMetaKey);
  const stamp: unknown = Reflect.get(meta, stampMetaKey);
  return {
    key: typeof key === "string" && effectKeyPattern.test(key) ? key : null,
    stamp: typeof stamp === "string" && stampPattern.test(stamp) ? stamp : null,
    confirmed: Reflect.get(meta, confirmedMetaKey) === true,
    find: Reflect.get(meta, findMetaKey) === true,
    attachments: Reflect.get(meta, attachmentsMetaKey),
  };
};

/** The recovery a tool's definition declares (`recoveryModes`). */
export const recoveryOf = (
  name: string,
  {
    readOnly,
    repeatable,
    find,
  }: { readOnly: boolean; repeatable?: true; find?: unknown }
): RecoveryMode => {
  if (repeatable === true && find !== undefined) {
    throw new Error(`${name}: a tool either repeats or finds its effect`);
  }
  if (readOnly && (repeatable === true || find !== undefined)) {
    throw new Error(`${name}: a read-only tool has no effect to recover`);
  }
  if (find !== undefined) {
    return "find";
  }
  return repeatable === true ? "repeat" : "none";
};

/** Whether a request may change something at the provider: not a GET or HEAD. */
export const isWriteMethod = (method: string): boolean =>
  method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD";

/**
 * Throws if a tool declares more than one write (a route whose method isn't
 * GET or HEAD). Connect's "nothing was done" and "outcome unknown" rest on
 * each call sending at most one write, as its last request.
 */
export const checkOneWrite = (
  name: string,
  routes: readonly { method: string }[]
): void => {
  if (routes.filter(({ method }) => isWriteMethod(method)).length > 1) {
    throw new Error(`${name}: a tool declares at most one write route`);
  }
};

/**
 * A tool's input or output schema as its generated contract holds it:
 * JSON data, without the `$schema` marker, which says nothing about the
 * values it allows.
 */
export const contractSchemaOf = (
  schema: Record<string, unknown>
): ActionManifest["contract"]["input"] => {
  const { $schema: _marker, ...rest } = schema;
  return z.record(z.string(), z.json()).parse(structuredClone(rest));
};

/** The keywords that say what a JSON Schema node allows. */
const typeKeywords = ["type", "anyOf", "oneOf", "allOf", "const", "enum"];

const typesOf = (schema: JsonObject): unknown[] =>
  Array.isArray(schema.type) ? schema.type : [schema.type];

/**
 * Whether a JSON Schema allows only what it spells out, at every depth and
 * in every branch: each node names its type (an empty schema, as
 * `z.unknown()` and `z.any()` make, allows anything), each object names
 * its properties and refuses any other (`additionalProperties: false`),
 * and each array says what its items are. References and patterns count
 * as open.
 */
export const isClosed = (schema: unknown): boolean => {
  if (schema === false) {
    return true;
  }
  if (
    !isRecord(schema) ||
    !typeKeywords.some((keyword) => keyword in schema) ||
    ["$ref", "patternProperties", "not", "if", "dependentSchemas"].some(
      (keyword) => keyword in schema
    )
  ) {
    return false;
  }
  const types = typesOf(schema);
  const branches = [schema.anyOf, schema.oneOf, schema.allOf].flatMap(
    (branch): unknown[] => (Array.isArray(branch) ? branch : [])
  );
  const isObjectSchema = types.includes("object") || "properties" in schema;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const objectClosed =
    !isObjectSchema ||
    (schema.additionalProperties === false &&
      Object.values(properties).every(isClosed));
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : [];
  const arrayClosed =
    !(types.includes("array") || "items" in schema) ||
    ("items" in schema &&
      isClosed(schema.items) &&
      prefixItems.every(isClosed) &&
      (!("additionalItems" in schema) || isClosed(schema.additionalItems)));
  return branches.every(isClosed) && objectClosed && arrayClosed;
};

/** What an error result says of the call besides its message. */
export type FailureKind =
  | "failed"
  | "notPerformed"
  | "outcomeUnknown"
  | "absent";

const failureMeta: Record<FailureKind, JsonObject | undefined> = {
  failed: undefined,
  notPerformed: { [notPerformedMetaKey]: true },
  outcomeUnknown: { [outcomeUnknownMetaKey]: true },
  absent: { [effectAbsentMetaKey]: true },
};

/**
 * An error result: its message, its code when it has one, and whether it
 * did nothing, or may have done something nobody can confirm.
 */
export const failure = (
  text: string,
  details?: ToolErrorDetails,
  kind: FailureKind = "failed"
): CallResult => {
  const meta = failureMeta[kind];
  return {
    content: [{ type: "text", text }],
    ...(details === undefined
      ? {}
      : { structuredContent: { error: { message: text, ...details } } }),
    isError: true,
    ...(meta === undefined ? {} : { _meta: meta }),
  };
};

/** What a ToolError says of the call besides its message. */
const kindOf = ({ notPerformed, outcomeUnknown }: ToolError): FailureKind => {
  if (notPerformed) {
    return "notPerformed";
  }
  return outcomeUnknown ? "outcomeUnknown" : "failed";
};

/**
 * The error result of a failed `run`: a ToolError as it says; an error the
 * tool didn't foresee of a writing tool as of unknown outcome, since it
 * may have come after its write, the last request it sends; of a read as
 * failed, since a read changed nothing either way.
 */
export const runFailure = (error: unknown, readOnly: boolean): CallResult => {
  if (error instanceof ToolError) {
    return failure(error.message, error.details, kindOf(error));
  }
  return readOnly
    ? failure("The action failed")
    : failure("The action's outcome is unknown", undefined, "outcomeUnknown");
};

/**
 * A lookup of a call's effect (`findMetaKey`): what `find` found; else an
 * error result. Only a `null` from `find` says the effect certainly isn't
 * there (`effectAbsentMetaKey`). Every other failure is a plain one, of a
 * lookup that tells nothing, whatever it says of itself: a throttled GET
 * did nothing, but that doesn't make the effect absent.
 */
export const lookUp = async <Data, Output>(
  find:
    | ((
        data: Data,
        effect: { key: string }
      ) => Promise<ToolResult<Output> | null>)
    | undefined,
  data: Data,
  key: string | null
): Promise<ToolResult<Output> | CallResult> => {
  if (find === undefined || key === null) {
    return failure("This call's effect can't be looked up");
  }
  let found: ToolResult<Output> | null;
  try {
    found = await find(data, { key });
  } catch (error) {
    return failure(
      error instanceof ToolError ? error.message : "The lookup failed"
    );
  }
  return found ?? failure("The call's effect isn't there", undefined, "absent");
};

/** A connector: what connect knows of it, and its MCP server. */
export interface Connector {
  manifest: ConnectorManifest;
  /** Answers one MCP request (Streamable HTTP, JSON responses, stateless). */
  fetch: (request: Request) => Promise<Response>;
}

/** What a connector is, besides its tools and syncs. */
export interface ConnectorBase {
  name: string;
  provider: ConnectorProvider;
  /** An app's provider record (sign-in.ts); never a suite's. */
  signIn?: SignInInput;
  scopes: readonly string[];
  hosts: readonly string[];
}

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const callParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

/** JSON-RPC error codes. */
const parseError = -32_700;
const invalidRequest = -32_600;
const methodNotFound = -32_601;
const invalidParams = -32_602;

type Id = string | number | null;

const answer = (id: Id, result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id, result });

const refusal = (id: Id, code: number, message: string): Response =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * A connector's MCP server, from its tools and syncs. Throws if two tools
 * or two syncs share a name, or the manifest they make isn't valid (a
 * route to a host it doesn't list).
 */
export const serveConnector = (
  base: ConnectorBase,
  toolList: readonly Tool[],
  syncList: readonly Sync[] = []
): Connector => {
  const tools = new Map<string, Tool>();
  for (const tool of toolList) {
    if (tools.has(tool.name)) {
      throw new Error(`Two tools are named ${tool.name}`);
    }
    tools.set(tool.name, tool);
  }
  const syncs = new Map<string, Sync>();
  for (const sync of syncList) {
    if (syncs.has(sync.name)) {
      throw new Error(`Two syncs are named ${sync.name}`);
    }
    syncs.set(sync.name, sync);
  }
  const manifest = connectorManifestSchema.parse({
    ...base,
    actions: Object.fromEntries(
      toolList.map(({ name, action }) => [name, action])
    ),
    ...(syncs.size === 0
      ? {}
      : {
          syncs: Object.fromEntries(
            [...syncs.values()].map(({ name, manifest: declared }) => [
              name,
              declared,
            ])
          ),
        }),
  });

  const respond = async (
    id: Id,
    method: string,
    params: JsonObject
  ): Promise<Response> => {
    switch (method) {
      case "initialize": {
        return answer(id, {
          protocolVersion: mcpProtocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: manifest.name, version: "1.0.0" },
        });
      }
      case "ping": {
        return answer(id, {});
      }
      case "tools/list": {
        return answer(id, {
          tools: [...tools.values()].map(({ description }) => description),
        });
      }
      case "tools/call": {
        const call = callParamsSchema.safeParse(params);
        // Names match exactly: no case folding, no normalising.
        const tool = call.success ? tools.get(call.data.name) : undefined;
        if (tool === undefined) {
          return refusal(id, invalidParams, "No such tool");
        }
        return answer(
          id,
          await tool.call(call.data?.arguments ?? {}, call.data?._meta)
        );
      }
      case syncMethod: {
        const sync = syncParamsSchema.safeParse(params);
        const found = sync.success ? syncs.get(sync.data.name) : undefined;
        if (found === undefined) {
          return refusal(id, invalidParams, "No such sync");
        }
        return answer(id, await found.call(params));
      }
      case syncPlacesMethod: {
        const sync = syncPlacesParamsSchema.safeParse(params);
        const found = sync.success ? syncs.get(sync.data.name) : undefined;
        if (found === undefined || found.manifest.places === "own") {
          return refusal(id, invalidParams, "No such sync with places");
        }
        return answer(id, await found.places(params));
      }
      default: {
        return refusal(id, methodNotFound, "No such method");
      }
    }
  };

  return {
    manifest,
    fetch: async (request) => {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return refusal(null, parseError, "Not JSON");
      }
      const message = requestSchema.safeParse(body);
      if (!message.success) {
        return refusal(null, invalidRequest, "Not a JSON-RPC request");
      }
      const { id, method, params = {} } = message.data;
      // A notification (no ID) gets no answer.
      if (id === undefined) {
        return new Response(null, { status: 202 });
      }
      return await respond(id, method, params);
    },
  };
};
