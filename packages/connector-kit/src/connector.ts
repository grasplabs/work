import type { ConnectorProvider } from "@grasp-os/shared/connect";
import { z } from "zod";

import {
  connectorManifestSchema,
  effectAbsentMetaKey,
  effectKeyMetaKey,
  effectKeyPattern,
  findMetaKey,
  mcpProtocolVersion,
  notPerformedMetaKey,
  outcomeUnknownMetaKey,
  provenanceMetaKey,
  provenanceSchema,
  resourceMetaKey,
  stampMetaKey,
  stampPattern,
} from "./manifest.ts";
import type {
  ActionManifest,
  ConnectorManifest,
  RecoveryMode,
  Route,
} from "./manifest.ts";
import type { SignInInput } from "./sign-in.ts";

// How a native connector is written: its tools, each with what connect
// decides by (read-only or not, the one resource it acts on, the requests
// it sends), strict input and typed output; and the MCP server connect
// talks to, in the connector's own isolate.
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
}

export interface ToolDefinition<
  Input extends z.ZodObject,
  Output extends z.ZodObject,
> {
  /** The action's name, as permissions name it, such as `mail.list`. */
  name: string;
  description: string;
  /**
   * Strict all the way down (`z.strictObject`): unknown keys are refused,
   * never dropped, and there are no aliases or case-insensitive keys, so
   * nothing but `resource` can select a resource. `defineTool` refuses
   * input whose JSON Schema leaves anything open (`z.unknown()`,
   * `z.any()`, records, loose objects).
   *
   * What it can't see, reviewers must refuse: `z.preprocess` and
   * `.transform` run before or after the schema it checks, so they can
   * read a key under another name (an alias), or rename one, unseen.
   */
  input: Input;
  output: Output;
  /** Only a read-only tool runs without an idempotency key (R7). */
  readOnly: boolean;
  /** Whether it may destroy something; any tool that isn't read-only by default. */
  destructive?: boolean;
  /**
   * The one input property that selects the resource it acts on (a
   * mailbox, a calendar), so a permission can be held to one resource. No
   * other property, at any depth, may select a resource.
   */
  resource?: Extract<keyof z.input<Input>, string>;
  /**
   * The only requests it may send (threat model Q11). A path parameter
   * named after the resource property (`{mailbox}`) must hold the resource
   * a call's capability names, whenever it names one. Where the provider
   * can't name the resource in the path, the tool's own code holds the
   * call to it. At most one route writes (not GET or HEAD).
   */
  routes: readonly Route[];
  /**
   * How a call reads to the person asked to confirm it, for a tool that
   * isn't read-only: a title ("Send an email") and the input properties
   * that matter, each under a label. They see each value exactly as the
   * call holds it, and are told when the input holds more than these show,
   * so list every property that changes what the call does. Without it
   * they see the action's name and the raw input.
   */
  describe?: {
    title: string;
    fields: readonly {
      label: string;
      input: Extract<keyof z.input<Input>, string>;
    }[];
  };
  /**
   * The tool reads a file and answers its content as `contentAs` makes it:
   * input `as` (text or base64), output `name`, `contentType`, `encoding`
   * and `content`. A workflow action may then ask core to keep the answer
   * as a file of its run (GRA-886) instead of passing the bytes on. Only a
   * read-only tool declares it.
   */
  answersFile?: true;
  /**
   * Carries the call out. `effect.key` is the call's effect key
   * (`effectKeyMetaKey`), for a side effect connect sent one for; null
   * otherwise. A tool that can recover gives it to its provider.
   */
  run: (
    input: z.output<Input>,
    effect: Effect
  ) => Promise<ToolResult<z.input<Output>>>;
  /**
   * The write can't take effect twice under one effect key: the provider
   * keeps the key as an idempotency key, or the write sets a state
   * (labels, a flag) rather than adding something. Connect may then send a
   * call of unknown outcome again, under the same key (recovery `repeat`).
   * Say so only when that holds for every input.
   */
  repeatable?: true;
  /**
   * Looks the effect of the call with `effect.key` up, instead of carrying
   * it out (recovery `find`): its result as `run` would have answered it,
   * if it happened; null only if it certainly didn't. A ToolError if it
   * can't tell. It may send only GET requests, on the tool's own routes,
   * so `run` must give the key to the provider in a way it can be found
   * by: a tag on what it makes.
   */
  find?: (
    input: z.output<Input>,
    effect: { key: string }
  ) => Promise<ToolResult<z.input<Output>> | null>;
}

/** The effect key a call carries, and its stamp, if connect sent them. */
export interface Effect {
  key: string | null;
  /**
   * The stamp core recorded for a workflow run's mail (`stampMetaKey`),
   * for a mail tool to put on what it sends as `stampHeader`; null
   * otherwise.
   */
  stamp: string | null;
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
  | "not_a_file";

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

type JsonObject = Record<string, unknown>;

interface CallResult {
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

/**
 * What a call's `_meta` asks: its effect key, its stamp, and whether to
 * find it.
 */
const callMetaOf = (
  meta: unknown
): { key: string | null; stamp: string | null; find: boolean } => {
  if (typeof meta !== "object" || meta === null) {
    return { key: null, stamp: null, find: false };
  }
  const key: unknown = Reflect.get(meta, effectKeyMetaKey);
  const stamp: unknown = Reflect.get(meta, stampMetaKey);
  return {
    key: typeof key === "string" && effectKeyPattern.test(key) ? key : null,
    stamp: typeof stamp === "string" && stampPattern.test(stamp) ? stamp : null,
    find: Reflect.get(meta, findMetaKey) === true,
  };
};

/** The recovery a tool's definition declares (`recoveryModes`). */
const recoveryOf = (
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

/**
 * A tool's input or output schema as its generated contract holds it:
 * JSON data, without the `$schema` marker, which says nothing about the
 * values it allows.
 */
const contractSchemaOf = (
  schema: Record<string, unknown>
): ActionManifest["contract"]["input"] => {
  const { $schema: _marker, ...rest } = schema;
  return z.record(z.string(), z.json()).parse(structuredClone(rest));
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
const isClosed = (schema: unknown): boolean => {
  if (schema === false) {
    return true;
  }
  if (
    !isObject(schema) ||
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
  const properties = isObject(schema.properties) ? schema.properties : {};
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
type FailureKind = "failed" | "notPerformed" | "outcomeUnknown" | "absent";

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
const failure = (
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
const runFailure = (error: unknown, readOnly: boolean): CallResult => {
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
const lookUp = async <Data, Output>(
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

/** Where input didn't parse, without the values that were sent. */
const issuesOf = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const keys = issue.code === "unrecognized_keys" ? issue.keys : [];
      const at = [...issue.path, ...keys].map(String).join(".");
      return `${issue.code}${at === "" ? "" : ` at ${at}`}`;
    })
    .join("; ");

/** The properties a tool that answers a file answers it with (`contentAs`). */
const fileAnswerFields = ["name", "contentType", "encoding", "content"];

/**
 * Whether a tool declaring `answersFile` has its shape: read-only, an `as`
 * input, and the file answer's fields among its output's.
 */
const answersFileShape = ({
  readOnly,
  input,
  output,
}: {
  readOnly: boolean;
  input: z.ZodObject;
  output: z.ZodObject;
}): boolean =>
  readOnly &&
  Object.hasOwn(input.shape, "as") &&
  fileAnswerFields.every((field) => Object.hasOwn(output.shape, field));

/**
 * A tool. Throws if it breaks the connector contract: input that isn't
 * strict everywhere, a resource that isn't one of its string properties.
 */
export const defineTool = <
  Input extends z.ZodObject,
  Output extends z.ZodObject,
>(
  definition: ToolDefinition<Input, Output>
): Tool => {
  const { name, input, output, resource, readOnly, routes } = definition;
  const recovery = recoveryOf(name, definition);
  const inputSchema = z.toJSONSchema(input, { io: "input" });
  const outputSchema = z.toJSONSchema(output, { io: "output" });
  if (!isClosed(inputSchema)) {
    throw new Error(`${name}: its input must be strict objects throughout`);
  }
  if (definition.answersFile === true && !answersFileShape(definition)) {
    throw new Error(
      `${name}: a tool that answers a file is read-only, takes \`as\`, and answers \`name\`, \`contentType\`, \`encoding\` and \`content\``
    );
  }
  const resourceProperty: unknown =
    resource === undefined ? undefined : inputSchema.properties?.[resource];
  if (
    resource !== undefined &&
    (!isObject(resourceProperty) || resourceProperty.type !== "string")
  ) {
    throw new Error(`${name}: its resource must be a string property`);
  }
  const meta: JsonObject = {};
  if (resource !== undefined) {
    meta[resourceMetaKey] = resource;
  }
  return {
    name,
    action: {
      routes: [...routes],
      readOnly,
      recovery,
      resource: resource ?? null,
      input: Object.keys(inputSchema.properties ?? {}),
      ...(definition.answersFile === true
        ? { answersFile: true as const }
        : {}),
      contract: {
        input: contractSchemaOf(inputSchema),
        output: contractSchemaOf(outputSchema),
      },
      ...(definition.describe === undefined
        ? {}
        : {
            describe: {
              title: definition.describe.title,
              fields: [...definition.describe.fields],
            },
          }),
    },
    description: {
      name,
      description: definition.description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: definition.destructive ?? !readOnly,
        openWorldHint: true,
      },
      _meta: meta,
    },
    call: async (args, callMeta) => {
      const parsed = input.safeParse(args);
      if (!parsed.success) {
        return failure(`Invalid input: ${issuesOf(parsed.error)}`);
      }
      const effect = callMetaOf(callMeta);
      let result: ToolResult<z.input<Output>>;
      if (effect.find) {
        const looked = await lookUp(definition.find, parsed.data, effect.key);
        if (!("output" in looked)) {
          return looked;
        }
        result = looked;
      } else {
        try {
          result = await definition.run(parsed.data, {
            key: effect.key,
            stamp: effect.stamp,
          });
        } catch (error) {
          return runFailure(error, readOnly);
        }
      }
      const checked = output.safeParse(result.output);
      const provenance = provenanceSchema.safeParse(result.provenance ?? []);
      if (!checked.success || !provenance.success) {
        // A writing tool that got this far sent its write: it went through,
        // but what it made can't be told.
        return failure(
          "The connector's result isn't what it declares",
          undefined,
          readOnly ? "failed" : "outcomeUnknown"
        );
      }
      const structured: JsonObject = checked.data;
      // Connect reads structured content only, so the output isn't sent a
      // second time as text: a file's content would take twice the room.
      return {
        content: [],
        structuredContent: structured,
        _meta: { [provenanceMetaKey]: provenance.data },
      };
    },
  };
};

export interface ConnectorDefinition {
  name: string;
  version: string;
  provider: ConnectorProvider;
  /** An app's provider record (sign-in.ts); never a suite's. */
  signIn?: SignInInput;
  scopes: readonly string[];
  hosts: readonly string[];
  tools: readonly Tool[];
}

/** A connector: what connect knows of it, and its MCP server. */
export interface Connector {
  manifest: ConnectorManifest;
  /** Answers one MCP request (Streamable HTTP, JSON responses, stateless). */
  fetch: (request: Request) => Promise<Response>;
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
 * A connector, from its tools. Throws if two tools share a name, or the
 * manifest they make isn't valid (a route to a host it doesn't list).
 */
export const defineConnector = (definition: ConnectorDefinition): Connector => {
  const tools = new Map<string, Tool>();
  for (const tool of definition.tools) {
    if (tools.has(tool.name)) {
      throw new Error(`Two tools are named ${tool.name}`);
    }
    tools.set(tool.name, tool);
  }
  const manifest = connectorManifestSchema.parse({
    name: definition.name,
    version: definition.version,
    provider: definition.provider,
    signIn: definition.signIn,
    scopes: definition.scopes,
    hosts: definition.hosts,
    actions: Object.fromEntries(
      definition.tools.map(({ name, action }) => [name, action])
    ),
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
          serverInfo: { name: manifest.name, version: manifest.version },
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
