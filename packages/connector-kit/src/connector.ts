import {
  callMetaOf,
  changeMetaKey,
  checkOneWrite,
  contractSchemaOf,
  failure,
  isClosed,
  lookUp,
  provenanceMetaKey,
  provenanceSchema,
  readAsSchema,
  recoveryOf,
  resourceMetaKey,
  runFailure,
  serveConnector,
} from "@grasp-os/runtime/connector";
import type {
  ActionManifest,
  Connector,
  ConnectorBase,
  JsonObject,
  Route,
  Sync,
  Tool,
  ToolResult,
} from "@grasp-os/runtime/connector";
import type { ToolReach } from "@grasp-os/shared/connect";
import {
  attachmentRefsSchema,
  attachmentsMatch,
  attachmentsProperty,
  attachmentsSchema,
  sha256Pattern,
} from "@grasp-os/shared/connector-attachments";
import { canonicalJson, isRecord } from "@grasp-os/shared/json";
import { z } from "zod";

// The connector kit's old way of writing a tool: Zod input and output and
// a `run` function, served by the runtime's MCP server
// (@grasp-os/runtime/connector). Only the Google Workspace and Microsoft
// 365 connectors still write tools this way: they move to
// @grasp-os/sdk/connector (GRA-2323, GRA-2324), and this package goes with
// the last of them (GRA-2329).

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
  /**
   * Whom it reaches: `own`, only the person it acts for; `company`, what
   * the company keeps together; `others`, other people (`toolReaches`).
   * Say the furthest any call of it can reach: its class follows from this
   * and `readOnly`, and a company turns classes on, not tools.
   */
  reach: ToolReach;
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
   * The tool reads one item and answers its content, not a list or a view
   * of several: a message, a page. Its provenance names exactly that item,
   * checked when it runs. Core keeps what such a tool reads of the
   * person's own things as a source in the Brain (GRA-1730); nothing else
   * is kept. Only a read-only tool declares it.
   */
  answersItem?: true;
  /**
   * The write attaches files (GRA-887): its input has an `attachments`
   * property, exactly {@link attachmentsSchema}, naming each file by name,
   * type, size and digest. The bytes come beside the input, and
   * `effect.files` holds them, by digest, only after the kit checked every
   * part against the input; none is ever missing or extra. In its
   * generated contract the property names run files by ID instead: a
   * workflow's action gives those, and core turns them into digests and
   * bytes. A message's name and type for a file are the input's, which
   * core took from its own record of the run's file; build the provider's
   * request from them with the provider's own encoding, never by joining
   * text.
   */
  takesFiles?: true;
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
   * The bytes of the files the input attaches (`takesFiles`), by the
   * SHA-256 of each: exactly those the input's digests name. Empty for any
   * other call.
   */
  files: ReadonlyMap<string, Uint8Array>;
  /**
   * The stamp core recorded for a workflow run's mail (`stampMetaKey`),
   * for a mail tool to put on what it sends as `stampHeader`; null
   * otherwise.
   */
  stamp: string | null;
  /**
   * Whether the call is a held side effect its person confirmed, on a card
   * that showed its exact input (`confirmedMetaKey`).
   */
  confirmed: boolean;
}

/**
 * The `attachments` input of a tool that takes files (`takesFiles`): what a
 * write attaches, by digest, within the platform's limits. A tool's input
 * has exactly this, which `defineTool` checks.
 */
export const attachmentsInput = attachmentsSchema.optional();

/** A file a write attaches: its entry, and the bytes the kit checked. */
export type AttachedFile = z.output<typeof attachmentsSchema>[number] & {
  bytes: Uint8Array;
};

/**
 * The files `attachments` (a tool's `attachments` input) names, each with
 * its bytes from `effect.files`, which the kit checked against the input
 * before the tool ran: none is missing, so one that is can only be a bug.
 */
export const attachedFiles = (
  attachments: z.output<typeof attachmentsSchema> | undefined,
  effect: Pick<Effect, "files">
): AttachedFile[] =>
  (attachments ?? []).map((entry) => {
    const bytes = effect.files.get(entry.sha256);
    if (bytes === undefined) {
      throw new Error("An attached file's bytes are missing");
    }
    return { ...entry, bytes };
  });

/** The attachments an input names, if it has any. */
const attachmentsOf = (input: unknown): z.output<typeof attachmentsSchema> => {
  const named: unknown =
    isRecord(input) && attachmentsProperty in input
      ? input[attachmentsProperty]
      : undefined;
  return named === undefined ? [] : attachmentsSchema.parse(named);
};

/** The files a call sent, base64 by digest, as bytes; undefined if not so. */
const sentFilesOf = (sent: unknown): Map<string, Uint8Array> | undefined => {
  if (sent === undefined) {
    return new Map();
  }
  const parsed = z
    .record(z.string().regex(sha256Pattern), z.string())
    .safeParse(sent);
  if (!parsed.success) {
    return undefined;
  }
  try {
    return new Map(
      Object.entries(parsed.data).map(([sha256, base64]) => [
        sha256,
        Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0),
      ])
    );
  } catch {
    return undefined;
  }
};

/**
 * The files of a call of a tool that takes files, checked against the
 * input's digests: every part, and no other, of the length and the SHA-256
 * its entry says. Undefined when they aren't.
 */
const checkedFilesOf = async (
  entries: readonly z.output<typeof attachmentsSchema>[number][],
  sent: unknown
): Promise<Map<string, Uint8Array> | undefined> => {
  const files = sentFilesOf(sent);
  return files !== undefined &&
    (await attachmentsMatch(entries, Object.fromEntries(files)))
    ? files
    : undefined;
};

/** A schema as plain JSON, without the `$schema` marker. */
const plainSchemaOf = (schema: z.ZodType): JsonObject => {
  const { $schema: _marker, ...rest } = z.toJSONSchema(schema, {
    io: "input",
  });
  return rest;
};

/**
 * Whether a tool's `attachments` input is exactly
 * {@link attachmentsSchema}, as JSON Schema: the limits a connector
 * declares are the platform's, whatever its code does with them.
 */
const takesAttachmentsExactly = (inputSchema: JsonObject): boolean => {
  const property = isRecord(inputSchema.properties)
    ? inputSchema.properties[attachmentsProperty]
    : undefined;
  return (
    isRecord(property) &&
    canonicalJson(z.json().parse(property)) ===
      canonicalJson(z.json().parse(plainSchemaOf(attachmentsSchema)))
  );
};

/**
 * `contract` with its `attachments` property as a workflow's action names
 * its files, by run file ID (`attachmentRefsSchema`): the shape core
 * resolves into the digests the tool's own input holds.
 */
const withFileRefs = (
  contract: ActionManifest["contract"]["input"]
): ActionManifest["contract"]["input"] => {
  const { properties } = contract;
  if (!isRecord(properties)) {
    return contract;
  }
  return {
    ...contract,
    properties: z.record(z.string(), z.json()).parse({
      ...properties,
      [attachmentsProperty]: plainSchemaOf(attachmentRefsSchema),
    }),
  };
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

/** Whether `input` has an `as` property that takes `as`. */
const takesAs = (input: z.ZodObject, as: string): boolean => {
  const field: unknown = Object.hasOwn(input.shape, "as")
    ? input.shape.as
    : undefined;
  return field instanceof z.ZodType && field.safeParse(as).success;
};

/**
 * Whether a tool declaring `answersFile` has its shape: read-only, an `as`
 * input that takes each of `readAsSchema`'s (core keeps a file read as
 * text, a run's files one read as base64), and the file answer's fields
 * among its output's.
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
  readAsSchema.options.every((as) => takesAs(input, as)) &&
  fileAnswerFields.every((field) => Object.hasOwn(output.shape, field));

/**
 * Throws if what a tool declares of files and items doesn't fit it: only
 * a write takes files, with exactly the platform's attachments input; a
 * tool that answers a file has that shape; only a read answers an item.
 */
const checkDeclared = (
  definition: Pick<
    ToolDefinition<z.ZodObject, z.ZodObject>,
    | "name"
    | "readOnly"
    | "input"
    | "output"
    | "takesFiles"
    | "answersFile"
    | "answersItem"
  >,
  inputSchema: JsonObject
): void => {
  const { name, readOnly } = definition;
  if (definition.takesFiles === true) {
    if (readOnly) {
      throw new Error(`${name}: only a write takes files`);
    }
    if (!takesAttachmentsExactly(inputSchema)) {
      throw new Error(
        `${name}: a tool that takes files has an optional \`attachments\` input of exactly the platform's attachments schema`
      );
    }
  }
  if (definition.answersItem === true && !readOnly) {
    throw new Error(`${name}: only a read answers an item`);
  }
  if (definition.answersFile === true && !answersFileShape(definition)) {
    throw new Error(
      `${name}: a tool that answers a file is read-only, takes \`as\` as text or base64, and answers \`name\`, \`contentType\`, \`encoding\` and \`content\``
    );
  }
};

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
  const { name, input, output, resource, readOnly, reach, routes } = definition;
  const recovery = recoveryOf(name, definition);
  checkOneWrite(name, routes);
  const inputSchema = z.toJSONSchema(input, { io: "input" });
  const outputSchema = z.toJSONSchema(output, { io: "output" });
  if (!isClosed(inputSchema)) {
    throw new Error(`${name}: its input must be strict objects throughout`);
  }
  checkDeclared(definition, inputSchema);
  const resourceProperty: unknown =
    resource === undefined ? undefined : inputSchema.properties?.[resource];
  if (
    resource !== undefined &&
    (!isRecord(resourceProperty) || resourceProperty.type !== "string")
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
      description: definition.description,
      routes: [...routes],
      readOnly,
      reach,
      recovery,
      resource: resource ?? null,
      input: Object.keys(inputSchema.properties ?? {}),
      ...(definition.answersFile === true
        ? { answersFile: true as const }
        : {}),
      ...(definition.answersItem === true
        ? { answersItem: true as const }
        : {}),
      ...(definition.takesFiles === true ? { takesFiles: true as const } : {}),
      contract: {
        input:
          definition.takesFiles === true
            ? withFileRefs(contractSchemaOf(inputSchema))
            : contractSchemaOf(inputSchema),
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
      // The files of a write that takes them, checked against the input's
      // digests before anything is used: a part missing, extra, of another
      // length or hashing to another digest fails the call, whatever sent
      // it. A tool that takes none is sent none.
      let files = new Map<string, Uint8Array>();
      if (!effect.find) {
        if (definition.takesFiles === true) {
          const checkedFiles = await checkedFilesOf(
            attachmentsOf(parsed.data),
            effect.attachments
          );
          if (checkedFiles === undefined) {
            return failure("Invalid input: the attached files don't match");
          }
          files = checkedFiles;
        } else if (effect.attachments !== undefined) {
          return failure("Invalid input: this tool takes no files");
        }
      }
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
            confirmed: effect.confirmed,
            files,
          });
        } catch (error) {
          return runFailure(error, readOnly);
        }
      }
      const checked = output.safeParse(result.output);
      const provenance = provenanceSchema.safeParse(result.provenance ?? []);
      // A tool that answers an item names exactly that one.
      const itemNamed =
        definition.answersItem !== true || provenance.data?.length === 1;
      if (!checked.success || !provenance.success || !itemNamed) {
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
        _meta: {
          [provenanceMetaKey]: provenance.data,
          ...(result.change === undefined
            ? {}
            : { [changeMetaKey]: result.change }),
        },
      };
    },
  };
};

export interface ConnectorDefinition extends Omit<
  ConnectorBase,
  "credentialHosts"
> {
  tools: readonly Tool[];
  /** Its syncs (the runtime's sync.ts), for native sync; none by default. */
  syncs?: readonly Sync[];
}

/**
 * A connector, from its tools. Throws if two tools share a name, or the
 * manifest they make isn't valid (a route to a host it doesn't list).
 * The kit's connectors are Grasp's own suites, each host reviewed: the
 * credential goes to every host they list. On the SDK a connector says
 * which hosts take it (`auth`).
 */
export const defineConnector = ({
  tools,
  syncs,
  ...base
}: ConnectorDefinition): Connector =>
  serveConnector({ ...base, credentialHosts: base.hosts }, tools, syncs);
