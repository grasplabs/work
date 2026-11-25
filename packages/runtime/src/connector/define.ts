import type { ToolReach } from "@grasp-os/shared/connect";
import {
  attachmentLimits,
  attachmentRefsJsonSchema,
  attachmentsMatch,
  attachmentsProperty,
} from "@grasp-os/shared/connector-attachment-rules";
import { identifierMaxLength } from "@grasp-os/shared/identifier";
import { isRecord } from "@grasp-os/shared/json";
import { runFileLimits, runFileTypes } from "@grasp-os/shared/run-file-limits";

import { jsonSchemaOf } from "../common/json-schema.ts";
import type { JsonValue, ValueDescriptor } from "../common/value-descriptor.ts";
import type { AnySchema } from "../common/value-schema.ts";
import type {
  Infer,
  InferInput,
  ObjectOutput,
  ValueShape,
} from "../common/value-types.ts";
import { v } from "../common/values.ts";
import { apiFor, routeOf } from "./api.ts";
import type { Api, RouteText } from "./api.ts";
import { fromBase64 } from "./content.ts";
import type { ActionManifest, Route } from "./manifest.ts";
import {
  changeMetaKey,
  maxChangeBytes,
  maxProvenanceItems,
  provenanceMetaKey,
  readAs,
  resourceMetaKey,
} from "./protocol.ts";
import {
  callMetaOf,
  checkOneWrite,
  contractSchemaOf,
  failure,
  isClosed,
  isWriteMethod,
  lookUp,
  recoveryOf,
  runFailure,
  serveConnector,
  ToolError,
} from "./server.ts";
import type {
  CallMeta,
  CallResult,
  Connector,
  JsonObject,
  Tool,
} from "./server.ts";
import type {
  AccountLookup,
  DeclaredRights,
  IdTokenCheck,
  SignInInput,
  TenantKind,
} from "./sign-in.ts";
import type { Sync } from "./sync.ts";
import { isDeliveringPath } from "./tool-rules.ts";

// How a connector is written (@grasp-os/sdk/connector): its tools, each one
// route of the vendor's API with `v` for its arguments and what it
// returns, and how a person signs in to the vendor. `defineConnector` makes
// it the MCP server connect loads into an isolate for each call, and the
// manifest connect decides by before it runs anything.

/** What a call gives a handler besides its arguments and the API. */
export interface ToolCall {
  /**
   * The call's effect key, for a write connect may recover: the same for
   * every attempt of one call, different for any other. A tool that finds
   * its effect (`find`) gives it to the vendor, as a tag on what it makes.
   * Null for a read.
   */
  key: string | null;
  /**
   * The stamp core recorded for a workflow run's mail, which a mail tool
   * puts on what it sends or drafts as the `stampHeader` header; null
   * otherwise.
   */
  stamp: string | null;
  /**
   * Whether the call is a held write its person confirmed, on a card that
   * showed its exact args.
   */
  confirmed: boolean;
  /**
   * The bytes of the files a write that takes files attaches, by SHA-256:
   * exactly those its `attachments` name, checked before the handler runs
   * (`attachedFiles`). Empty for any other call.
   */
  files: ReadonlyMap<string, Uint8Array>;
  /**
   * Says what a write changed, once, for the audit's before and after: at
   * most `maxChangeBytes` of JSON. A change past that, or a second one,
   * fails the call.
   */
  changed: (change: { before: JsonValue; after: JsonValue }) => void;
}

/**
 * The `attachments` argument of a write that takes files (`takesFiles`),
 * exactly: each file by name, type, size and SHA-256, never its bytes,
 * within the platform's limits (the kit's `attachmentsSchema`, which
 * checks each call's again before its handler runs).
 */
export const attachments = v
  .array(
    v.object({
      name: v.string().min(1).max(runFileLimits.nameLength),
      type: v.enum(runFileTypes),
      size: v.number().integer().min(0).max(attachmentLimits.fileBytes),
      sha256: v.string().min(64).max(64),
    })
  )
  .max(attachmentLimits.files)
  .optional();

/** A file a write attaches: its entry, and the bytes checked against it. */
export type AttachedFile = NonNullable<Infer<typeof attachments>>[number] & {
  bytes: Uint8Array;
};

/**
 * The files a write's `attachments` argument names, each with its bytes
 * from `call.files`, which were checked against the argument before the
 * handler ran: one that is missing can only be a bug.
 */
export const attachedFiles = (
  named: Infer<typeof attachments>,
  call: Pick<ToolCall, "files">
): AttachedFile[] =>
  (named ?? []).map((entry) => {
    const bytes = call.files.get(entry.sha256);
    if (bytes === undefined) {
      throw new Error("An attached file's bytes are missing");
    }
    return { ...entry, bytes };
  });

/** A tool's arguments, as its handler gets them. */
export type ToolArgs<Args extends ValueShape> = ObjectOutput<Args>;

interface ToolBase<
  Args extends ValueShape,
  Returns extends AnySchema,
  Routes extends readonly RouteText[],
> {
  description: string;
  /**
   * Whom it reaches: `own`, only the person it acts for; `company`, what
   * the company keeps together; `others`, other people; `conversations`,
   * what other people said where the person was. Say the furthest any call
   * can reach: its class follows from this and `readOnly`.
   */
  reach: ToolReach;
  /** The OAuth scopes it needs, among those its connector's `auth` asks for. */
  scopes?: readonly string[];
  /**
   * The only requests it may send, as `"METHOD /path"` with `{name}` for a
   * path parameter. At most one is a write (not GET or HEAD).
   */
  routes: Routes;
  /**
   * For a GET route of its own, the hosts its answer may redirect to
   * (`*.<host>`), which connect's egress follows once, without the token:
   * a download whose vendor answers with a link to its storage.
   */
  redirects?: Readonly<
    Partial<Record<Extract<Routes[number], `GET ${string}`>, readonly string[]>>
  >;
  /** Strict: a call with any other argument is refused. */
  args: Args;
  /** An object; the answer is checked against it before anyone sees it. */
  returns: Returns;
  /**
   * The one argument that names the record a call acts on (a mailbox, a
   * board), so a permission can be held to one. A path parameter of that
   * name is held to the record the call's permission names.
   */
  resource?: Extract<keyof Args, string>;
  handler: (
    args: ToolArgs<Args>,
    api: Api,
    call: ToolCall
  ) => Promise<InferInput<Returns>>;
}

/** A tool that only reads: it has no effect to recover. */
interface ReadTool<
  Args extends ValueShape,
  Returns extends AnySchema,
  Routes extends readonly RouteText[],
> extends ToolBase<Args, Returns, Routes> {
  readOnly: true;
  repeatable?: never;
  find?: never;
  describe?: never;
  takesFiles?: never;
  /**
   * It reads one item and answers it, not a list: a message, a page. The
   * answer's own `id` is its provenance, exactly one item, which core may
   * keep of the person's own things as a source in the Brain.
   */
  answersItem?: true;
  /**
   * It reads a file and answers it as `contentAs` makes it: an `as` arg
   * that takes `text` and `base64`, and an answer with `name`,
   * `contentType`, `encoding` and `content`. A workflow may keep the
   * answer as a file of its run.
   */
  answersFile?: true;
  /**
   * It reads email, which the platform's mail rules hold: through a mail
   * tool whose resource is `mailbox`, a chat's agent reaches only its
   * person's own mailbox or one pointed at for them; and what a read of
   * mail answers was written by others, which a card confirming a write
   * after it says.
   */
  mail?: true;
}

/**
 * A tool that writes. Without `repeatable` or `find` a call whose outcome
 * is unknown stays unknown, and connect never sends it twice.
 */
interface WriteTool<
  Args extends ValueShape,
  Returns extends AnySchema,
  Routes extends readonly RouteText[],
> extends ToolBase<Args, Returns, Routes> {
  readOnly: false;
  answersItem?: never;
  answersFile?: never;
  /**
   * How a call reads to the person asked to confirm it: a title ("Send an
   * email") and the args that matter, each under a label, shown exactly as
   * the call holds them. They are told when a call holds more than these
   * show, so list every arg that changes what it does.
   */
  describe?: {
    title: string;
    fields: readonly { label: string; arg: Extract<keyof Args, string> }[];
  };
  /**
   * It attaches files: its `attachments` arg is exactly `attachments`,
   * and `call.files` holds their bytes (`attachedFiles`).
   */
  takesFiles?: true;
  /**
   * It changes email (`true`), held by the same rules as a read of it; or
   * it mails someone, sending or drafting, and `recipients` are the args
   * holding the addresses it mails, as address strings or within objects.
   * Core records them with the stamp a workflow run's mail carries
   * (`ToolCall.stamp`), so the mail that comes back is known as the run's.
   */
  mail?: true | { recipients: readonly Extract<keyof Args, string>[] };
  /**
   * Sending it twice changes nothing (it sets a state, or the vendor keeps
   * the call's key), so connect may send a call of unknown outcome again.
   */
  repeatable?: true;
  /**
   * Looks the effect of the call with `call.key` up instead of carrying it
   * out: what the handler would have answered if it happened, null only if
   * it certainly didn't. Its `api` has only the tool's reads.
   */
  find?: (
    args: ToolArgs<Args>,
    api: Api,
    call: Pick<ToolCall, "stamp" | "changed"> & { key: string }
  ) => Promise<InferInput<Returns> | null>;
}

export type ToolDeclaration<
  Args extends ValueShape,
  Returns extends AnySchema,
  Routes extends readonly RouteText[] = readonly RouteText[],
> = ReadTool<Args, Returns, Routes> | WriteTool<Args, Returns, Routes>;

/**
 * What a tool knows of its connector: its name, the hosts it may reach,
 * and the path its routes are under.
 */
interface ToolConnector {
  title: string;
  hosts: readonly string[];
  base?: string;
}

/** A tool, as `tool` declares it and `defineConnector` takes it. */
export interface ConnectorTool {
  readonly scopes: readonly string[];
  /** Its routes as declared, under the connector's `base`. */
  readonly routes: readonly RouteText[];
  /** Each argument's descriptor. */
  readonly args: Readonly<Record<string, ValueDescriptor>>;
  readonly returns: ValueDescriptor;
  /** The tool as the runtime's server serves it, named `name` on `connector`. */
  readonly serve: (name: string, connector: ToolConnector) => Tool;
}

const methodOf = (route: string): string => route.split(" ", 1)[0] ?? "";

/** One list answer: its items, and where the next page starts, or null. */
export const page = <const Item extends AnySchema>(item: Item) =>
  v.object({ items: v.array(item), next: v.string().nullable() });

/** A checkpoint a sync or an event's poll keeps between reads. */
export type Checkpoint = Readonly<
  Record<string, string | number | boolean | null>
>;

/**
 * An event type: what a workflow can start on. Declared and typed here;
 * connect reads it from Phase 3 of the connector layer on.
 */
export interface EventDeclaration<
  Filter extends ValueShape,
  Payload extends AnySchema,
> {
  description: string;
  filter: Filter;
  payload: Payload;
  /** The same for one occurrence however it arrives, so it's passed on once. */
  id: (payload: Infer<Payload>) => string;
  poll: {
    routes: readonly `GET ${string}`[];
    handler: (
      filter: ObjectOutput<Filter>,
      cursor: string | null,
      api: Api
    ) => Promise<{ events: InferInput<Payload>[]; cursor: string | null }>;
  };
}

/**
 * An event or a sync, as `event` and `sync` declare it and
 * `defineConnector` takes it: the routes it reads, so far. Its own types
 * stay where it is declared, as a tool's do (`ConnectorTool`).
 */
export interface ConnectorReader {
  readonly routes: readonly `GET ${string}`[];
}

/** An event type (`EventDeclaration`). */
export const event = <
  const Filter extends ValueShape,
  const Payload extends AnySchema,
>(
  declaration: EventDeclaration<Filter, Payload>
): ConnectorReader => ({ routes: declaration.poll.routes });

/**
 * Records kept in step with the vendor's: one page at a time from a
 * checkpoint. Declared and typed here; connect reads it from Phase 4 of
 * the connector layer on.
 */
export interface SyncDeclaration<Model extends AnySchema> {
  model: Model;
  id: (record: Infer<Model>) => string;
  mode: "incremental" | "full";
  routes: readonly `GET ${string}`[];
  handler: (
    checkpoint: Checkpoint | null,
    api: Api
  ) => Promise<{
    upserts: InferInput<Model>[];
    deletes: string[];
    checkpoint: Checkpoint;
    more: boolean;
  }>;
}

/** A sync (`SyncDeclaration`). */
export const sync = <const Model extends AnySchema>(
  declaration: SyncDeclaration<Model>
): ConnectorReader => ({ routes: declaration.routes });

/** How a person signs in to the vendor, as connect runs it. */
export interface ConnectorAuth {
  readonly signIn: DistributiveOmit<SignInInput, "name">;
  /**
   * The hosts a sign-in's credential goes to: among the connector's hosts,
   * as declared. Without them, the connector's one host; a connector with
   * several names them.
   */
  readonly hosts?: readonly string[];
}

type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown
  ? Omit<Value, Key>
  : never;

/**
 * Where connect reads whose account a sign-in is: an HTTPS GET on one of
 * the connector's hosts, and JSON Pointers into its answer.
 */
export type AccountDeclaration = AccountLookup;

/**
 * Where connect reads whose account a sign-in is from the OpenID ID token:
 * its issuer (`{tenant}` filled), the claim of the account's stable ID,
 * the claims its name and address are read from, the first that is there,
 * the claims that must say what they say here (`{tenant}` filled,
 * compared without case) or be `true`, and those that must be absent or
 * the issuer itself.
 */
export type IdTokenDeclaration = IdTokenCheck;

/**
 * What a consent asks for by the tool classes the company has on (each
 * scope among the sign-in's `scopes`): `signIn` always, each class's
 * while it is on, `implied` what a scope takes in besides itself, and
 * `sharedMailbox` while a shared mailbox is pointed at (`reach` only with
 * Reach others on too).
 */
export type RightsDeclaration = DeclaredRights;

/** OAuth 2.0 with the authorization code, PKCE and refresh. */
export type OAuth2Declaration = {
  /** May hold `{tenant}` past its host, as `tokenUrl` may. */
  authorizeUrl: string;
  tokenUrl: string;
  /** RFC 7009; without one, disconnecting deletes the tokens only. */
  revokeUrl?: string;
  /** Each scope it may ask for, and what it allows. */
  scopes: Readonly<Record<string, string>>;
  /** Parameters the authorization request adds; values may hold `{tenant}`. */
  params?: Readonly<Record<string, string>>;
  /**
   * The kind of the organization's own tenant at the vendor (`guid`, an
   * Entra tenant ID; `domain`, a hosted domain): the flow is pinned to it.
   * Only a provider the deployment has a tenant for can be pinned.
   */
  tenant?: TenantKind;
  rights?: RightsDeclaration;
  /** A prefix the token answer may put on a scope (a URL ending in `/`). */
  scopePrefix?: string;
  /** Scopes a renewed token must hold, or its connection is asked to reconnect. */
  renewalRequires?: readonly string[];
  /** `account`: revoking one token revokes the account's whole grant. */
  grant?: "account";
  /**
   * Where the token response names the host of each of the connector's
   * host templates (`{company}.example.com`): a JSON Pointer to a host or
   * an HTTPS origin, such as `/api_domain`. Connect checks it fits the
   * template before any request goes there.
   */
  hostsFrom?: Readonly<Record<string, string>>;
} & (
  | { account: AccountDeclaration; idToken?: never }
  | { idToken: IdTokenDeclaration; account?: never }
);

/** The sign-ins connect runs for a connector. Connector code never sees a token. */
export const auth = Object.freeze({
  /** OAuth 2.0 with the authorization code, PKCE and refresh. */
  oauth2: ({
    authorizeUrl,
    tokenUrl,
    revokeUrl,
    scopes,
    params,
    renewalRequires,
    hosts,
    ...rest
  }: OAuth2Declaration & Pick<ConnectorAuth, "hosts">): ConnectorAuth => ({
    ...(hosts === undefined ? {} : { hosts }),
    signIn: {
      kind: "oauth2",
      authorizationEndpoint: authorizeUrl,
      tokenEndpoint: tokenUrl,
      ...(revokeUrl === undefined ? {} : { revocationEndpoint: revokeUrl }),
      scopes: Object.keys(scopes),
      ...(params === undefined ? {} : { authorizationParams: { ...params } }),
      ...(renewalRequires === undefined
        ? {}
        : { renewalRequires: [...renewalRequires] }),
      ...rest,
    },
  }),
  /** A key the person pastes, sent in `header`, after `prefix` if it has one. */
  apiKey: ({
    hosts,
    ...declaration
  }: {
    header: string;
    prefix?: string;
    account: AccountDeclaration;
  } & Pick<ConnectorAuth, "hosts">): ConnectorAuth => ({
    ...(hosts === undefined ? {} : { hosts }),
    signIn: { kind: "api_key", ...declaration },
  }),
});

/**
 * The vendor's own MCP server, which a connector serves: every tool its
 * `tools/list` names, classed by the rules. `registration` says how
 * Grasp gets a client there: `"dcr"`, the server registers it;
 * `{ header }`, each person types a key that goes in that header.
 */
export interface McpDeclaration {
  /** The server's URL: https, without credentials, query or fragment. */
  url: string;
  registration: "dcr" | { header: string };
}

interface DeclarationBase {
  /** Its name: lowercase, as permissions and the catalogue name it. */
  name: string;
  /** Its vendor's name, as people read it: `Pipedrive`. */
  title: string;
  events?: Readonly<Record<string, ConnectorReader>>;
  syncs?: Readonly<Record<string, ConnectorReader>>;
}

/** A connector of its own tools, each a route of the vendor's API. */
interface ApiConnectorDeclaration extends DeclarationBase {
  mcp?: never;
  /**
   * Whose connections its calls get, and whose sign-in its `auth` is:
   * its `name` unless it says otherwise.
   */
  provider?: string;
  /** Every host it may reach, exactly. */
  hosts: readonly string[];
  /**
   * The path every route is under (`/api/v2`), or none: routes are
   * declared without it and the API puts it in front, so a version or an
   * `/api` prefix never names a tool.
   */
  base?: string;
  /**
   * The vendor's OpenAPI spec its tools are generated from: where it was
   * read, its SHA-256, and the security scheme it was read for where the
   * generator was given one. Connect's build holds the tools to it.
   */
  openapi?: {
    readonly url: string;
    readonly sha256: string;
    readonly scheme?: string;
  };
  auth: ConnectorAuth;
  tools: Readonly<Record<string, ConnectorTool>>;
}

/**
 * A connector that serves its vendor's MCP server: its tools are the
 * server's, and signing in is the server's, learned from it (RFC 9728 and
 * 8414) or a person's key. It has no hosts, `auth`, tools, events or
 * syncs of its own.
 */
interface McpConnectorDeclaration extends DeclarationBase {
  mcp: McpDeclaration;
  provider?: never;
  hosts?: never;
  base?: never;
  openapi?: never;
  auth?: never;
  tools?: never;
  events?: never;
  syncs?: never;
}

export type ConnectorDeclaration =
  | ApiConnectorDeclaration
  | McpConnectorDeclaration;

/** Where a value didn't fit, without the value. */
const issuesText = (
  issues: readonly { code: string; path: readonly PropertyKey[] }[]
): string =>
  issues
    .map(({ code, path }) =>
      path.length === 0 ? code : `${code} at ${path.map(String).join(".")}`
    )
    .join("; ");

const asJsonObject = (schema: Record<string, JsonValue>): JsonObject => schema;

/** The properties a tool that answers a file answers it with (`contentAs`). */
const fileAnswerFields = ["name", "contentType", "encoding", "content"];

/**
 * Whether a tool that answers a file has its shape: an `as` arg that
 * takes each of `readAs` (core keeps a file read as text, a run's
 * files one read as base64), and the file answer's fields among its
 * answer's.
 */
const answersFileShape = ({
  args,
  returns: { descriptor },
}: {
  args: ValueShape;
  returns: AnySchema;
}): boolean => {
  const as = Object.hasOwn(args, "as") ? args.as : undefined;
  return (
    as !== undefined &&
    readAs.every(
      (each) => as["~standard"].validate(each).issues === undefined
    ) &&
    descriptor.kind === "object" &&
    fileAnswerFields.every((field) => Object.hasOwn(descriptor.fields, field))
  );
};

/**
 * Throws if what a tool declares of files doesn't fit it: one that takes
 * files has exactly `attachments` as its `attachments` arg; one that
 * answers a file has the shape `contentAs` makes.
 */
const checkFiles = (
  name: string,
  declaration: {
    args: ValueShape;
    returns: AnySchema;
    takesFiles?: true;
    answersFile?: true;
  }
): void => {
  if (
    declaration.takesFiles === true &&
    declaration.args[attachmentsProperty] !== attachments
  ) {
    throw new Error(
      `${name}: a tool that takes files has the SDK's \`attachments\` as its \`attachments\` argument`
    );
  }
  if (declaration.answersFile === true && !answersFileShape(declaration)) {
    throw new Error(
      `${name}: a tool that answers a file takes \`as\` as text or base64, and answers \`name\`, \`contentType\`, \`encoding\` and \`content\``
    );
  }
};

/**
 * A tool's `mail`, as its manifest holds it, if it declares one. Throws
 * for recipients that aren't among its args.
 */
const mailOf = (
  name: string,
  mail: true | { recipients: readonly string[] } | undefined,
  properties: Readonly<Record<string, unknown>>
): Pick<ActionManifest, "mail"> => {
  if (mail === undefined) {
    return {};
  }
  if (mail === true) {
    return { mail };
  }
  if (
    mail.recipients.length === 0 ||
    !mail.recipients.every((arg) => Object.hasOwn(properties, arg))
  ) {
    throw new Error(`${name}: its mail's recipients are some of its args`);
  }
  return { mail: { recipients: [...mail.recipients] } };
};

/**
 * The files of a call of a write that takes files, sent as base64 by
 * SHA-256, checked against the digests its `attachments` arg names (which
 * `attachments` has checked): every part and no other, of the length and
 * the SHA-256 its entry says. Undefined when they aren't. Connect checks
 * the entries' names and total against the platform's attachment schema
 * before it sends a call; the isolate doesn't load that schema's Zod.
 */
const checkedFilesOf = async (
  named: Infer<typeof attachments>,
  sent: unknown
): Promise<Map<string, Uint8Array> | undefined> => {
  const encoded = sent ?? {};
  if (!isRecord(encoded)) {
    return undefined;
  }
  const files = new Map<string, Uint8Array>();
  try {
    for (const [sha256, base64] of Object.entries(encoded)) {
      if (typeof base64 !== "string") {
        return undefined;
      }
      files.set(sha256, fromBase64(base64));
    }
  } catch {
    return undefined;
  }
  return (await attachmentsMatch(named ?? [], Object.fromEntries(files)))
    ? files
    : undefined;
};

/** Whether a call's provenance fits what connect keeps of it. */
const provenanceFits = (ids: readonly string[]): boolean =>
  ids.length <= maxProvenanceItems &&
  ids.every((id) => id.length > 0 && id.length <= identifierMaxLength);

/**
 * What an answer says it read: the string `id` of each of its `items`,
 * or else its own `id`, or nothing; only its own `id` for a tool that
 * answers an item.
 */
const provenanceOf = (answer: JsonObject, item: boolean): string[] => {
  if (!item && Array.isArray(answer.items)) {
    return answer.items.flatMap((each: unknown) =>
      isRecord(each) && typeof each.id === "string" ? [each.id] : []
    );
  }
  return typeof answer.id === "string" ? [answer.id] : [];
};

/**
 * The files a call may use: those of a write that takes files, checked
 * against its args' digests before anything uses them (a part missing,
 * extra, of another length or hashing to another digest fails the call).
 * A tool that takes none is sent none, and neither is a lookup.
 */
const callFilesOf = async (
  takesFiles: boolean,
  meta: CallMeta,
  value: object
): Promise<Map<string, Uint8Array> | CallResult> => {
  if (meta.find) {
    return new Map();
  }
  if (!takesFiles) {
    return meta.attachments === undefined
      ? new Map()
      : failure("Invalid input: this tool takes no files");
  }
  const named = attachments["~standard"].validate(
    Reflect.get(value, attachmentsProperty)
  );
  const files =
    named.issues === undefined
      ? await checkedFilesOf(named.value, meta.attachments)
      : undefined;
  return files ?? failure("Invalid input: the attached files don't match");
};

type Change = Parameters<ToolCall["changed"]>[0];

/** Whether a change fits what connect keeps (`maxChangeBytes`). */
const changeFits = (change: Change): boolean =>
  new TextEncoder().encode(JSON.stringify(change)).byteLength <= maxChangeBytes;

/**
 * The result of a call that answered `output` and reported `changes`:
 * the answer, checked against `returns`, with its provenance and its
 * change. One that isn't what the tool declares fails, and a write that
 * got this far sent its write: it went through, but what it made can't be
 * told.
 */
const resultOf = (
  output: unknown,
  changes: readonly Change[],
  {
    returns,
    readOnly,
    answersItem,
  }: { returns: AnySchema; readOnly: boolean; answersItem: boolean }
): CallResult => {
  const checked = returns["~standard"].validate(output);
  const answer =
    checked.issues === undefined && isRecord(checked.value)
      ? checked.value
      : undefined;
  const provenance =
    answer === undefined ? [] : provenanceOf(answer, answersItem);
  const [change, ...more] = changes;
  if (
    answer === undefined ||
    !provenanceFits(provenance) ||
    (answersItem && provenance.length !== 1) ||
    more.length > 0 ||
    (change !== undefined && !changeFits(change))
  ) {
    return failure(
      "The connector's result isn't what it declares",
      undefined,
      readOnly ? "failed" : "outcomeUnknown"
    );
  }
  // Connect reads structured content only, so the output isn't sent a
  // second time as text.
  return {
    content: [],
    structuredContent: answer,
    _meta: {
      [provenanceMetaKey]: provenance,
      ...(change === undefined ? {} : { [changeMetaKey]: change }),
    },
  };
};

/** A declared tool as the runtime's server serves it. */
const toolOf = <
  Args extends ValueShape,
  Returns extends AnySchema,
  Routes extends readonly RouteText[],
>(
  connector: ToolConnector,
  name: string,
  declaration: ToolDeclaration<Args, Returns, Routes>
): Tool => {
  const { readOnly, reach, resource, handler } = declaration;
  const redirects: Readonly<Record<string, readonly string[] | undefined>> =
    declaration.redirects ?? {};
  const routes: Route[] = declaration.routes.map((route) => {
    const hosts = Object.hasOwn(redirects, route)
      ? redirects[route]
      : undefined;
    return {
      ...routeOf(route, connector.hosts, connector.base),
      ...(hosts === undefined ? {} : { redirects: [...hosts] }),
    };
  });
  const args = v.object(declaration.args);
  const { returns } = declaration;
  if (returns.descriptor.kind !== "object" || returns.descriptor.nullable) {
    throw new Error(`${name}: it returns an object`);
  }
  const inputSchema = asJsonObject(jsonSchemaOf(args.descriptor));
  const outputSchema = asJsonObject(
    jsonSchemaOf(returns.descriptor, { exact: true })
  );
  if (!isClosed(inputSchema)) {
    throw new Error(`${name}: its args must be strict objects throughout`);
  }
  const properties = isRecord(inputSchema.properties)
    ? inputSchema.properties
    : {};
  const resourceProperty =
    resource === undefined ? undefined : properties[resource];
  if (
    resource !== undefined &&
    (typeof resourceProperty !== "object" ||
      resourceProperty === null ||
      Reflect.get(resourceProperty, "type") !== "string")
  ) {
    throw new Error(`${name}: its resource must be a string argument`);
  }
  checkFiles(name, declaration);
  const mail = mailOf(name, declaration.mail, properties);
  const takesFiles = declaration.takesFiles === true;
  const answersItem = declaration.answersItem === true;
  const { describe } = declaration;
  const action: ActionManifest = {
    description: declaration.description,
    routes,
    readOnly,
    reach,
    recovery: recoveryOf(name, declaration),
    resource: resource ?? null,
    input: Object.keys(properties),
    ...(declaration.answersFile === true ? { answersFile: true as const } : {}),
    ...(answersItem ? { answersItem: true as const } : {}),
    ...(takesFiles ? { takesFiles: true as const } : {}),
    ...mail,
    ...(describe === undefined
      ? {}
      : {
          describe: {
            title: describe.title,
            fields: describe.fields.map(({ label, arg }) => ({
              label,
              input: arg,
            })),
          },
        }),
    contract: {
      // A workflow's action names the files by run file ID, which core
      // turns into the digests and bytes the tool itself takes.
      input: contractSchemaOf(
        takesFiles
          ? {
              ...inputSchema,
              properties: {
                ...properties,
                [attachmentsProperty]: attachmentRefsJsonSchema,
              },
            }
          : inputSchema
      ),
      output: contractSchemaOf(outputSchema),
    },
  };
  const reads = routes.filter(({ method }) => !isWriteMethod(method));
  const find =
    declaration.readOnly || declaration.find === undefined
      ? undefined
      : declaration.find;
  const call = async (input: unknown, sent: unknown): Promise<CallResult> => {
    const parsed = args["~standard"].validate(input);
    if (parsed.issues !== undefined) {
      return failure(`Invalid input: ${issuesText(parsed.issues)}`);
    }
    const meta = callMetaOf(sent);
    const files = await callFilesOf(takesFiles, meta, parsed.value);
    if (!(files instanceof Map)) {
      return files;
    }
    const changes: Change[] = [];
    const changed = (change: Change): void => {
      changes.push(change);
    };
    let output: unknown;
    if (meta.find) {
      const looked = await lookUp(
        find === undefined
          ? undefined
          : async (data: typeof parsed.value, effect: { key: string }) => {
              const found = await find(
                data,
                apiFor(connector.title, connector.hosts, reads, connector.base)
                  .api,
                { key: effect.key, stamp: meta.stamp, changed }
              );
              return found === null ? null : { output: found };
            },
        parsed.value,
        meta.key
      );
      if (!("output" in looked)) {
        return looked;
      }
      ({ output } = looked);
    } else {
      const { api, wrote } = apiFor(
        connector.title,
        connector.hosts,
        routes,
        connector.base
      );
      try {
        output = await handler(parsed.value, api, {
          key: meta.key,
          stamp: meta.stamp,
          confirmed: meta.confirmed,
          files,
          changed,
        });
      } catch (error) {
        // Once its write may have done something, whatever the handler
        // throws leaves the outcome unknown: a read's refusal rethrown
        // after the write can't say that nothing, or nothing yet, was done.
        return runFailure(
          wrote() && error instanceof ToolError && !error.outcomeUnknown
            ? new ToolError("The action's outcome is unknown", {
                outcomeUnknown: true,
              })
            : error,
          readOnly
        );
      }
    }
    return resultOf(output, changes, { returns, readOnly, answersItem });
  };
  return {
    name,
    action,
    description: {
      name,
      description: declaration.description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        openWorldHint: true,
      },
      _meta: resource === undefined ? {} : { [resourceMetaKey]: resource },
    },
    call,
  };
};

/**
 * A tool: one route of the vendor's API. Throws if it declares more than
 * one write, both `repeatable` and `find`, or redirects for anything but
 * a GET route of its own.
 */
export const tool = <
  const Args extends ValueShape,
  const Returns extends AnySchema,
  const Routes extends readonly RouteText[],
>(
  declaration: ToolDeclaration<Args, Returns, Routes>
): ConnectorTool => {
  checkOneWrite(
    "A tool",
    declaration.routes.map((route) => ({ method: methodOf(route) }))
  );
  recoveryOf("A tool", declaration);
  const routes: readonly string[] = declaration.routes;
  for (const route of Object.keys(declaration.redirects ?? {})) {
    if (!routes.includes(route) || methodOf(route) !== "GET") {
      throw new Error(
        `"${route}": a tool's redirects are for its own GET routes`
      );
    }
  }
  return {
    scopes: declaration.scopes ?? [],
    routes: declaration.routes,
    args: Object.fromEntries(
      Object.entries(declaration.args).map(([name, schema]) => [
        name,
        schema.descriptor,
      ])
    ),
    returns: declaration.returns.descriptor,
    serve: (name, connector) => toolOf(connector, name, declaration),
  };
};

/** A connector written on the SDK: its server, and what it declares. */
export interface DefinedConnector extends Connector {
  /** Read by connect's build, which holds its tools to the mirror rule. */
  readonly declaration: ConnectorDeclaration;
}

/** A declared connector served with `syncs` (`defineConnector`). */
const serveDeclared = (
  declaration: ConnectorDeclaration,
  nativeSyncs: readonly Sync[]
): DefinedConnector => {
  const {
    name,
    title,
    hosts = [],
    base,
    tools = {},
    events = {},
    syncs = {},
  } = declaration;
  for (const { routes } of [
    ...Object.values(events),
    ...Object.values(syncs),
  ]) {
    for (const route of routes) {
      const { method, path } = routeOf(route, hosts, base);
      if (method !== "GET") {
        throw new Error(`"${route}": an event or a sync only reads, by GET`);
      }
      // Delivery only, as a sync's manifest is checked: never or change words
      // would refuse real reads (a drive item's permissions, a start token).
      if (isDeliveringPath(path)) {
        throw new Error(
          `"${route}": an event or a sync runs on its own, so its path may not deliver to people`
        );
      }
    }
  }
  const scopes = new Set(Object.values(tools).flatMap((each) => each.scopes));
  // Its tools first: a route to a host it doesn't list says so before
  // anything about where its credential goes.
  const served = Object.entries(tools).map(([toolName, each]) =>
    each.serve(toolName, { title, hosts, base })
  );
  // An MCP server's sign-in is its own, sent by connect's MCP client: no
  // credential of a connection goes through the egress.
  const credentialHosts =
    declaration.mcp === undefined
      ? (declaration.auth.hosts ?? (hosts.length === 1 ? hosts : undefined))
      : [];
  if (credentialHosts === undefined) {
    throw new Error(
      "The connector has several hosts: its auth names those its credential goes to (hosts)"
    );
  }
  return {
    ...serveConnector(
      {
        name,
        title,
        provider: declaration.provider ?? name,
        ...(declaration.mcp === undefined
          ? { signIn: { ...declaration.auth.signIn, name: title } }
          : { mcp: declaration.mcp }),
        scopes: [...scopes],
        hosts,
        credentialHosts,
      },
      served,
      nativeSyncs
    ),
    declaration,
  };
};

/**
 * A connector: its manifest, and the MCP server connect runs it as. Throws
 * if a tool breaks the connector contract (a route to a host it doesn't
 * list, args that aren't strict, a scope its sign-in doesn't ask for), or
 * an event or a sync reads a route off its hosts, or one whose path
 * delivers to people.
 */
export const defineConnector = (
  declaration: ConnectorDeclaration
): DefinedConnector => serveDeclared(declaration, []);

/**
 * `connector` serving the runtime's own native syncs besides (sync.ts),
 * as connect's Brain sync reads them today. Only the suites' syncs, kept on
 * `defineSync` until Phase 4 of the connector layer rewrites them as
 * declared syncs (GRA-2311), which deletes this: it isn't part of
 * `@grasp-os/sdk/connector`, and only the connector files the import
 * checks list (connect's build.ts, vite.config.ts) may reach it.
 */
export const withNativeSyncs = (
  connector: DefinedConnector,
  syncs: readonly Sync[]
): DefinedConnector => serveDeclared(connector.declaration, syncs);
