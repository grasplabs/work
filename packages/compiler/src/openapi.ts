import { v } from "@grasp-os/runtime/app";
import type { ValueDescriptor } from "@grasp-os/runtime/app";
import { isRecord } from "@grasp-os/shared/json";
import { dereference, upgrade, validate } from "@scalar/openapi-parser";

import {
  built,
  fieldsOf,
  list,
  OperationError,
  record,
  schemaOf,
} from "./openapi-schemas.ts";
import type { Modifiable, Reading, Schema } from "./openapi-schemas.ts";
import {
  httpMethods,
  isNamePart,
  pathSegments,
  routeName,
  standardActions,
  toolName,
} from "./tool-names.ts";
import type { HttpMethod, Segment } from "./tool-names.ts";

// The OpenAPI generator's reading of a spec (GRA-2319): a vendor's spec, read
// by a conformant parser (Scalar's: validated, upgraded to 3.1 and
// dereferenced, with nothing fetched), as the tools it becomes, one per
// operation. The generator writes them as source (openapi-source.ts) and
// the mirror check holds tools to them (mirror.ts).
//
// A spec is a vendor's text, so it is read as hostile: every name it gives
// is checked before it can reach source (a tool's name by the mirror rule,
// a route by the route grammar, a field's name by `v`), and a schema that
// refers to itself, nests too deep or grows too large is cut off. What
// can't be typed is left out and said: an optional parameter or a field of
// an answer is dropped, which makes a narrower tool, and an operation that
// can't be called without it is skipped with the reason.

/** The largest spec read: the largest public ones are about 7 MB. */
const specMaxBytes = 16 * 1024 * 1024;

/** How long a description may be; the rest is cut. */
const descriptionMaxLength = 1000;

/** Where a list's answer names its next page, by the vendor's name for it. */
const nextNames: ReadonlySet<string> = new Set([
  "next_cursor",
  "nextCursor",
  "next_page_token",
  "nextPageToken",
]);

/** The statuses an operation's answer is read from, the first one present. */
const successes = ["200", "201", "202", "203", "204", "205", "206", "2XX"];

/**
 * How a connector signs in, as the spec's security schemes say and the
 * SDK's `auth` takes it: OAuth 2.0's authorization code, or a key in a
 * header (a bearer token is one, after `Bearer `). Whose account a
 * sign-in is, no spec says: the connector adds it.
 */
export type SpecAuth =
  | {
      readonly kind: "oauth2";
      readonly authorizeUrl: string;
      readonly tokenUrl: string;
      readonly scopes: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "apiKey";
      readonly header: string;
      readonly prefix?: string;
    };

/** One argument the route takes outside the body. */
export interface SpecParameter {
  readonly name: string;
  readonly in: "path" | "query";
  /** For an array sent as one value: what joins its items. */
  readonly separator?: string;
}

/** A list's answer: where its items and its next page's cursor are. */
export interface SpecPage {
  readonly item: ValueDescriptor;
  /** Keys from the answer to its items; none when the answer is the list. */
  readonly items: readonly string[];
  /** Keys from the answer to the cursor; undefined when it names none. */
  readonly next: readonly string[] | undefined;
}

/** One operation, as the tool it becomes. */
export interface SpecOperation {
  readonly name: string;
  readonly method: HttpMethod;
  /** The route's path as the spec keys it, under the API's base path. */
  readonly path: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly scopes: readonly string[];
  readonly parameters: readonly SpecParameter[];
  /** The body's fields, among the arguments beside the parameters. */
  readonly body: readonly string[];
  /** An object: every parameter and body field, as the vendor names them. */
  readonly args: ValueDescriptor;
  /** The vendor's answer, or undefined where it answers nothing. */
  readonly answer: ValueDescriptor | undefined;
  /** The answer as the tool gives it: the vendor's, or a page of it. */
  readonly returns: ValueDescriptor;
  readonly page: SpecPage | undefined;
}

/** An operation that became no tool, and why. */
export interface SkippedOperation {
  readonly operation: string;
  readonly reason: string;
}

export interface Spec {
  /** SHA-256 of the spec's text, in hex. */
  readonly sha256: string;
  readonly host: string;
  /** The path every route starts with, `/api/v2`, or `` for none. */
  readonly base: string;
  readonly auth: SpecAuth | undefined;
  readonly operations: readonly SpecOperation[];
  readonly skipped: readonly SkippedOperation[];
}

/** A spec that can't be read at all. */
export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

type Node = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const quoted = (value: string): string => JSON.stringify(value);

const sha256 = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const serverVariable = /\{(?<name>[^{}]*)\}/gu;

/** The spec's one server: its host, and the path every route starts with. */
const serverOf = (
  document: Node,
  url: string
): { host: string; base: string } => {
  const server = record(list(document.servers)[0]);
  const template = text(server.url);
  if (template === undefined) {
    throw new SpecError("The spec names no server.");
  }
  const variables = record(server.variables);
  const filled = template.replaceAll(serverVariable, (...match: unknown[]) => {
    const name = text(record(match.at(-1)).name) ?? "";
    const fallback = text(record(variables[name]).default);
    if (fallback === undefined) {
      throw new SpecError(
        `The server's variable ${quoted(name)} has no default.`
      );
    }
    return fallback;
  });
  if (!URL.canParse(filled, url)) {
    throw new SpecError("The spec's server isn't a URL.");
  }
  const address = new URL(filled, url);
  if (
    address.protocol !== "https:" ||
    address.username !== "" ||
    address.password !== "" ||
    address.search !== "" ||
    address.hash !== ""
  ) {
    throw new SpecError("The spec's server must be a plain HTTPS address.");
  }
  const base = address.pathname.replace(/\/$/u, "");
  const segments = pathSegments(base === "" ? "/" : base);
  if (
    segments === undefined ||
    segments.some((segment) => segment.kind !== "literal")
  ) {
    throw new SpecError("The spec's server has a path no route may take.");
  }
  return { host: address.host, base };
};

const httpsUrl = (value: unknown): string | undefined => {
  const candidate = text(value);
  if (candidate === undefined || !URL.canParse(candidate)) {
    return undefined;
  }
  const address = new URL(candidate);
  const plain =
    address.protocol === "https:" &&
    address.username === "" &&
    address.password === "";
  return plain ? address.href : undefined;
};

const oauthOf = (scheme: Node): SpecAuth | undefined => {
  const flow = record(record(scheme.flows).authorizationCode);
  const authorizeUrl = httpsUrl(flow.authorizationUrl);
  const tokenUrl = httpsUrl(flow.tokenUrl);
  const scopes = Object.fromEntries(
    Object.entries(record(flow.scopes)).flatMap(([scope, description]) =>
      typeof description === "string"
        ? [[scope, description.slice(0, descriptionMaxLength)]]
        : []
    )
  );
  return authorizeUrl === undefined || tokenUrl === undefined
    ? undefined
    : { kind: "oauth2", authorizeUrl, tokenUrl, scopes };
};

/** A scheme as the sign-in it becomes, or undefined for one not supported. */
const authOf = (scheme: Node): SpecAuth | undefined => {
  if (scheme.type === "oauth2") {
    return oauthOf(scheme);
  }
  const name = text(scheme.name);
  if (
    scheme.type === "apiKey" &&
    scheme.in === "header" &&
    name !== undefined
  ) {
    return { kind: "apiKey", header: name };
  }
  const bearer = text(scheme.scheme)?.toLowerCase() === "bearer";
  return scheme.type === "http" && bearer
    ? { kind: "apiKey", header: "Authorization", prefix: "Bearer " }
    : undefined;
};

/** The order the connector picks among the schemes a spec offers. */
const preference: Readonly<Record<SpecAuth["kind"], number>> = {
  oauth2: 0,
  apiKey: 1,
};

/**
 * The scheme the connector signs in with: `wanted`, the name the spec
 * gives it, where the connector picks one, or else the one people sign in
 * with most easily among those the operations take.
 */
const chosenScheme = (
  document: Node,
  requirements: readonly unknown[],
  wanted: string | undefined
): { name: string; auth: SpecAuth } | undefined => {
  const schemes = record(record(document.components).securitySchemes);
  const used = new Set(
    requirements.flatMap((requirement) => Object.keys(record(requirement)))
  );
  const candidates = [...used].flatMap((name) => {
    const auth = authOf(record(schemes[name]));
    return auth === undefined ? [] : [{ name, auth }];
  });
  if (wanted === undefined) {
    candidates.sort(
      (a, b) => preference[a.auth.kind] - preference[b.auth.kind]
    );
    return candidates[0];
  }
  const named = candidates.find((candidate) => candidate.name === wanted);
  if (named === undefined) {
    throw new SpecError(
      `No operation signs in with a scheme ${quoted(wanted)} the connector can use.`
    );
  }
  return named;
};

/**
 * The scopes an operation needs under the chosen scheme, from the first
 * requirement that scheme meets alone (one naming two schemes needs both at
 * once). Every scope a requirement lists is needed, as OpenAPI reads it.
 */
const scopesOf = (
  requirements: readonly unknown[],
  scheme: { name: string; auth: SpecAuth } | undefined
): string[] => {
  if (requirements.length === 0) {
    return [];
  }
  for (const requirement of requirements) {
    const names = Object.keys(record(requirement));
    if (names.length === 0) {
      return [];
    }
    if (
      scheme !== undefined &&
      names.length === 1 &&
      names[0] === scheme.name
    ) {
      const scopes = list(record(requirement)[scheme.name]).filter(
        (scope): scope is string => typeof scope === "string"
      );
      const declared = scheme.auth.kind === "oauth2" ? scheme.auth.scopes : {};
      if (scopes.some((scope) => !Object.hasOwn(declared, scope))) {
        throw new OperationError(
          "It needs a scope its sign-in doesn't declare."
        );
      }
      return scopes;
    }
  }
  throw new OperationError("It needs a sign-in the connector doesn't use.");
};

const scalarKinds: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "literal",
  "enum",
]);

/** What joins an array's items in a query sent as one value, by style. */
const separators: Readonly<Record<string, string>> = {
  form: ",",
  spaceDelimited: " ",
  pipeDelimited: "|",
};

interface Declared {
  readonly name: string;
  readonly where: string;
  readonly node: Node;
}

/**
 * How a query sends an array, by the parameter's style: item by item (the
 * exploded form), joined into one value, or undefined for a style not sent.
 */
const arrayStyle = (node: Node): { separator?: string } | undefined => {
  const style = text(node.style) ?? "form";
  const exploded =
    node.explode === undefined ? style === "form" : node.explode === true;
  if (exploded) {
    return style === "form" ? {} : undefined;
  }
  return Object.hasOwn(separators, style)
    ? { separator: separators[style] }
    : undefined;
};

/**
 * Whether a value names every key it may hold, as a tool's arguments must
 * throughout (the runtime's `isClosed`): no record and no free-form JSON.
 */
const isStrict = (descriptor: ValueDescriptor): boolean => {
  if (descriptor.kind === "record" || descriptor.kind === "json") {
    return false;
  }
  if (descriptor.kind === "object") {
    return Object.values(descriptor.fields).every(isStrict);
  }
  if (descriptor.kind === "array") {
    return isStrict(descriptor.item);
  }
  return descriptor.kind !== "union" || descriptor.members.every(isStrict);
};

/** Whether a path segment may hold the value: a string or a number, never null or a boolean. */
const holdsSegment = (descriptor: ValueDescriptor): boolean => {
  if (descriptor.nullable) {
    return false;
  }
  if (descriptor.kind === "literal") {
    return (
      typeof descriptor.value === "string" ||
      typeof descriptor.value === "number"
    );
  }
  return ["string", "number", "enum"].includes(descriptor.kind);
};

/** One parameter as an argument, or undefined where it can't be typed. */
const parameterOf = (
  { name, where, node }: Declared,
  segments: readonly Segment[],
  reading: Reading
): { field: Schema; parameter: SpecParameter } | undefined => {
  const inPath = segments.some(
    (segment) => segment.kind === "parameter" && segment.name === name
  );
  if (node.content !== undefined || (where === "path" && !inPath)) {
    return undefined;
  }
  if (where !== "path" && where !== "query") {
    return undefined;
  }
  const schema = schemaOf(node.schema, reading, 1);
  const descriptor = schema?.descriptor;
  if (schema === undefined || descriptor === undefined) {
    return undefined;
  }
  const required = node.required === true || where === "path";
  const field = required ? schema : schema.optional();
  if (where === "path" && !holdsSegment(descriptor)) {
    return undefined;
  }
  if (scalarKinds.has(descriptor.kind)) {
    return { field, parameter: { name, in: where } };
  }
  const items =
    descriptor.kind === "array" && scalarKinds.has(descriptor.item.kind);
  const sent = where === "query" && items ? arrayStyle(node) : undefined;
  return sent === undefined
    ? undefined
    : { field, parameter: { name, in: where, ...sent } };
};

/** The arguments an operation takes outside its body. */
const parametersOf = (
  declared: readonly unknown[],
  path: string,
  reading: Reading
): { fields: Record<string, Schema>; parameters: SpecParameter[] } => {
  const byKey = new Map<string, Declared>();
  for (const node of declared) {
    const name = text(record(node).name);
    const where = text(record(node).in);
    if (name !== undefined && where !== undefined) {
      byKey.set(`${where} ${name}`, { name, where, node: record(node) });
    }
  }
  const segments = pathSegments(path) ?? [];
  for (const segment of segments) {
    if (segment.kind === "parameter" && !byKey.has(`path ${segment.name}`)) {
      throw new OperationError(
        `Its path parameter ${quoted(segment.name)} isn't declared.`
      );
    }
  }
  const fields: Record<string, Schema> = {};
  const parameters: SpecParameter[] = [];
  for (const entry of byKey.values()) {
    const typed = parameterOf(entry, segments, reading);
    const named =
      typed === undefined || Object.hasOwn(fields, entry.name)
        ? undefined
        : built(() => v.object({ [entry.name]: typed.field }));
    if (typed === undefined || named === undefined) {
      if (entry.node.required === true || entry.where === "path") {
        throw new OperationError(
          `Its ${entry.where} parameter ${quoted(entry.name)} can't be typed.`
        );
      }
      continue;
    }
    Object.defineProperty(fields, entry.name, {
      enumerable: true,
      value: typed.field,
    });
    parameters.push(typed.parameter);
  }
  return { fields, parameters };
};

const jsonMedia = /^application\/(?:[\w.-]+(?:\+[\w.-]+)*\+)?json(?:\s*;.*)?$/u;

/** A request's or an answer's content: whether it has any, and its JSON schema. */
const contentOf = (holder: unknown): { found: boolean; schema: unknown } => {
  const content = record(record(holder).content);
  const media = Object.keys(content).find((type) => jsonMedia.test(type));
  return media === undefined
    ? { found: Object.keys(content).length > 0, schema: undefined }
    : { found: true, schema: record(content[media]).schema };
};

/** A JSON body's fields; an optional body's, each optional. */
const bodyOf = (operation: Node, reading: Reading): Record<string, Schema> => {
  const body = operation.requestBody;
  if (!isRecord(body)) {
    return {};
  }
  const required = body.required === true;
  const { schema } = contentOf(body);
  const fields = isRecord(schema)
    ? fieldsOf(schema, reading, 1, !required)
    : undefined;
  if (fields === undefined && required) {
    throw new OperationError("Its body can't be typed as an object.");
  }
  return fields ?? {};
};

/** The success answer's schema, or undefined where it answers nothing. */
const answerOf = (
  operation: Node,
  reading: Reading
): Modifiable | undefined => {
  const responses = record(operation.responses);
  const code = successes.find((status) => Object.hasOwn(responses, status));
  if (code === undefined) {
    throw new OperationError("It declares no success answer.");
  }
  const { found, schema } = contentOf(responses[code]);
  if (!found) {
    return undefined;
  }
  const answer = schemaOf(schema, reading, 1);
  if (answer === undefined) {
    throw new OperationError("Its answer can't be typed.");
  }
  return answer;
};

/** Where the answer's fields name the next page's cursor, if they do. */
const cursorIn = (
  fields: Readonly<Record<string, ValueDescriptor>>,
  within: readonly string[]
): string[] | undefined => {
  const found = Object.entries(fields).find(
    ([name, field]) => nextNames.has(name) && field.kind === "string"
  );
  return found === undefined ? undefined : [...within, found[0]];
};

/** The page in a GET's answer: the one list it holds, and its cursor. */
const pageOf = (answer: ValueDescriptor): SpecPage | undefined => {
  if (answer.kind === "array") {
    return { item: answer.item, items: [], next: undefined };
  }
  if (answer.kind !== "object") {
    return undefined;
  }
  const entries = Object.entries(answer.fields);
  const lists = entries.flatMap(([name, field]) =>
    field.kind === "array" ? [{ name, item: field.item }] : []
  );
  const [only] = lists;
  if (lists.length !== 1 || only === undefined) {
    return undefined;
  }
  let next = cursorIn(answer.fields, []);
  for (const [name, field] of entries) {
    if (next === undefined && field.kind === "object") {
      next = cursorIn(field.fields, [name]);
    }
  }
  return { item: only.item, items: [only.name], next };
};

/** `{ items, next }`: what every list answers, as `page(item)` declares it. */
export const pageDescriptor = (item: ValueDescriptor): ValueDescriptor => ({
  descriptorVersion: 1,
  nullable: false,
  presence: "required",
  kind: "object",
  fields: {
    items: {
      descriptorVersion: 1,
      nullable: false,
      presence: "required",
      kind: "array",
      item,
    },
    next: v.string().nullable().descriptor,
  },
});

const descriptionOf = (operation: Node, fallback: string): string => {
  const written = (text(operation.summary) ?? text(operation.description) ?? "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, descriptionMaxLength);
  return written === "" ? fallback : written;
};

interface Candidate {
  /** Unnamed until every operation's standard name is known. */
  readonly operation: SpecOperation;
  /** The operation as the spec keys it: its method and path. */
  readonly label: string;
  readonly operationId: string | undefined;
  readonly family: string;
  readonly action: string | undefined;
}

interface Source {
  readonly method: HttpMethod;
  /** The path as the spec keys it, under the base. */
  readonly key: string;
  readonly item: Node;
  readonly operation: Node;
  readonly security: readonly unknown[];
  readonly scheme: { name: string; auth: SpecAuth } | undefined;
}

/**
 * What an operation answers: the vendor's answer, the page in it where a
 * GET on a collection answers one, and what the tool returns of it.
 */
const answeredBy = (
  operation: Node,
  collection: boolean,
  reading: Reading
): Pick<SpecOperation, "answer" | "page" | "returns"> => {
  const answer = answerOf(operation, reading)?.descriptor;
  if (answer === undefined) {
    return { answer, page: undefined, returns: v.object({}).descriptor };
  }
  const page = collection ? pageOf(answer) : undefined;
  if (page !== undefined) {
    return { answer, page, returns: pageDescriptor(page.item) };
  }
  if (answer.kind !== "object" || answer.nullable) {
    throw new OperationError("Its answer isn't an object.");
  }
  return { answer, page, returns: answer };
};

const candidateOf = (from: Source): Candidate => {
  const { method, item, operation } = from;
  const path = from.key;
  const segments = pathSegments(path);
  if (segments === undefined) {
    throw new OperationError("Its path isn't one a route may take.");
  }
  if (operation.servers !== undefined || item.servers !== undefined) {
    throw new OperationError("It is served from a server of its own.");
  }
  const request: Reading = {
    mode: "request",
    open: new Set(),
    read: { nodes: 0 },
  };
  const { fields, parameters } = parametersOf(
    [...list(item.parameters), ...list(operation.parameters)],
    path,
    request
  );
  const body = bodyOf(operation, request);
  for (const [name, field] of Object.entries(body)) {
    if (Object.hasOwn(fields, name)) {
      throw new OperationError(
        `Its body field ${quoted(name)} has a parameter's name.`
      );
    }
    Object.defineProperty(fields, name, { enumerable: true, value: field });
  }
  const args = built(() => v.object(fields));
  if (args === undefined) {
    throw new OperationError("Its arguments are too large.");
  }
  if (!isStrict(args.descriptor)) {
    throw new OperationError(
      "Its arguments take a free-form value, and a tool's are strict."
    );
  }
  const answered = answeredBy(
    operation,
    method === "GET" && segments.at(-1)?.kind === "literal",
    { ...request, mode: "response" }
  );
  const naming = routeName(
    { method, path, segments },
    answered.page !== undefined
  );
  if ("problem" in naming) {
    throw new OperationError(naming.problem);
  }
  const operationId = text(operation.operationId);
  return {
    operation: {
      name: "",
      method,
      path,
      description: descriptionOf(operation, `${method} ${from.key}`),
      readOnly: method === "GET" || method === "HEAD",
      scopes: scopesOf(from.security, from.scheme),
      parameters,
      body: Object.keys(body),
      args: args.descriptor,
      ...answered,
    },
    label: `${method} ${from.key}`,
    // A vendor's name that is a standard action would name the route as
    // one it isn't (a POST named `delete`): no name, as the mirror rule has it.
    operationId:
      operationId !== undefined &&
      isNamePart(operationId) &&
      !standardActions.has(operationId)
        ? operationId
        : undefined,
    family: naming.family,
    action: naming.action,
  };
};

/** A candidate's name by its standard action, if one applies. */
const standard = (candidate: Candidate): string | undefined =>
  candidate.action === undefined
    ? undefined
    : `${candidate.family}.${candidate.action}`;

/**
 * Names each candidate: its standard action where one applies and no other
 * operation would take the same name, the vendor's operation name otherwise.
 */
const named = (
  candidates: readonly Candidate[],
  skipped: SkippedOperation[]
): SpecOperation[] => {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const name = standard(candidate);
    if (name !== undefined) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const taken = new Set<string>();
  const operations: SpecOperation[] = [];
  for (const candidate of candidates) {
    const alone = counts.get(standard(candidate) ?? "") === 1;
    const action = alone ? candidate.action : candidate.operationId;
    const name =
      action === undefined ? undefined : toolName(candidate.family, action);
    if (name === undefined || taken.has(name)) {
      skipped.push({
        operation: candidate.label,
        reason:
          name === undefined
            ? "It needs a plain operation name for its tool's name, and has none."
            : `Another operation is named ${name}.`,
      });
      continue;
    }
    taken.add(name);
    operations.push({ ...candidate.operation, name });
  }
  return operations;
};

/** The spec as a document: validated, as OpenAPI 3.1, every reference resolved. */
const documentOf = async (input: string): Promise<Node> => {
  if (new TextEncoder().encode(input).byteLength > specMaxBytes) {
    throw new SpecError("The spec is larger than 16 MiB.");
  }
  const checked = await validate(input);
  if (!checked.valid) {
    const message = checked.errors[0]?.message ?? "it can't be read";
    throw new SpecError(`The spec isn't valid OpenAPI: ${message}`);
  }
  const { specification } = upgrade(checked.specification);
  if (specification === null) {
    throw new SpecError("The spec's OpenAPI version isn't one read here.");
  }
  return record(dereference(specification).schema);
};

/**
 * Reads a spec as tools: what both the generator and the mirror check work
 * from. `url` is where the spec was read from. Throws `SpecError` for a
 * spec that isn't valid OpenAPI or names no plain HTTPS server.
 */
export const readSpec = async (
  input: string,
  url: string,
  scheme?: string
): Promise<Spec> => {
  const document = await documentOf(input);
  const { host, base } = serverOf(document, url);
  const global = list(document.security);
  const operations: {
    key: string;
    method: HttpMethod;
    item: Node;
    operation: Node;
  }[] = [];
  for (const [key, item] of Object.entries(record(document.paths))) {
    for (const method of httpMethods) {
      const operation = record(item)[method.toLowerCase()];
      if (isRecord(operation)) {
        operations.push({ key, method, item: record(item), operation });
      }
    }
  }
  const security = (operation: Node): readonly unknown[] =>
    Array.isArray(operation.security) ? operation.security : global;
  const chosen = chosenScheme(
    document,
    operations.flatMap(({ operation }) => security(operation)),
    scheme
  );
  const skipped: SkippedOperation[] = [];
  const candidates: Candidate[] = [];
  for (const { key, method, item, operation } of operations) {
    try {
      candidates.push(
        candidateOf({
          method,
          key,
          item,
          operation,
          security: security(operation),
          scheme: chosen,
        })
      );
    } catch (error) {
      if (!(error instanceof OperationError)) {
        throw error;
      }
      skipped.push({ operation: `${method} ${key}`, reason: error.message });
    }
  }
  return {
    sha256: await sha256(input),
    host,
    base,
    auth: chosen?.auth,
    operations: named(candidates, skipped),
    skipped,
  };
};
