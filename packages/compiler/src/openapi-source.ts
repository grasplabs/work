import type { ValueDescriptor } from "@grasp-os/runtime/app";

import { readSpec } from "./openapi.ts";
import type { Spec, SpecAuth, SpecOperation } from "./openapi.ts";

// The OpenAPI generator's writing (GRA-2319): a spec's tools as ordinary
// `@grasp-os/sdk/connector` source, one `tool` per operation, in a file of
// their own that regeneration replaces. Every name and string the spec
// gives reaches the source as a JSON literal or a key checked as a plain
// identifier, never as code, and the file's comments are its own.

const json = (value: unknown): string => JSON.stringify(value);

const identifier = /^[A-Za-z_$][\w$]*$/u;

/** A property's key in an object literal: a JSON string unless plain. */
const keyOf = (name: string): string =>
  identifier.test(name) ? name : json(name);

/** Reads a property: `.name`, or `?.name` where it may be missing. */
const read = (name: string, maybe: boolean): string => {
  if (identifier.test(name)) {
    return `${maybe ? "?." : "."}${name}`;
  }
  return `${maybe ? "?." : ""}[${json(name)}]`;
};

/** A scalar's builder call, or undefined for a kind that holds values. */
const scalarOf = (descriptor: ValueDescriptor): string | undefined => {
  if (descriptor.kind === "string") {
    const format = (["email", "datetime", "date", "url"] as const).find(
      (name) => descriptor[name] === true
    );
    return format === undefined ? "v.string()" : `v.string().${format}()`;
  }
  if (descriptor.kind === "number") {
    return descriptor.integer ? "v.number().integer()" : "v.number()";
  }
  if (
    descriptor.kind === "boolean" ||
    descriptor.kind === "null" ||
    descriptor.kind === "json"
  ) {
    return `v.${descriptor.kind}()`;
  }
  if (descriptor.kind === "literal") {
    return `v.literal(${json(descriptor.value)})`;
  }
  return descriptor.kind === "enum"
    ? `v.enum(${json(descriptor.values)})`
    : undefined;
};

/** The builder call of a descriptor's own kind, its modifiers aside. */
const builderOf = (descriptor: ValueDescriptor, indent: string): string => {
  const scalar = scalarOf(descriptor);
  if (scalar !== undefined) {
    return scalar;
  }
  // oxlint-disable no-use-before-define -- what a value holds are values
  if (descriptor.kind === "array") {
    return `v.array(${valueOf(descriptor.item, indent)})`;
  }
  if (descriptor.kind === "record") {
    return `v.record(${valueOf(descriptor.value, indent)})`;
  }
  if (descriptor.kind === "union") {
    const members = descriptor.members.map((member) => valueOf(member, indent));
    return `v.union(${members.join(", ")})`;
  }
  if (descriptor.kind === "object") {
    return `v.object(${shapeOf(descriptor.fields, indent)})`;
  }
  // oxlint-enable no-use-before-define
  throw new Error(`A spec makes no ${descriptor.kind}.`);
};

const valueOf = (descriptor: ValueDescriptor, indent: string): string => {
  const nullable = descriptor.nullable ? ".nullable()" : "";
  const optional = descriptor.presence === "optional" ? ".optional()" : "";
  return `${builderOf(descriptor, indent)}${nullable}${optional}`;
};

const shapeOf = (
  fields: Readonly<Record<string, ValueDescriptor>>,
  indent: string
): string => {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return "{}";
  }
  const inner = `${indent}  `;
  const lines = entries.map(
    ([name, field]) => `${inner}${keyOf(name)}: ${valueOf(field, inner)},`
  );
  return `{\n${lines.join("\n")}\n${indent}}`;
};

/** The request a handler sends: its path, query and body, from its args. */
const requestOf = (operation: SpecOperation): string => {
  const argument = (name: string, separator?: string): string => {
    const value = `args${read(name, false)}`;
    const sent =
      separator === undefined ? value : `${value}?.join(${json(separator)})`;
    return `${keyOf(name)}: ${sent}`;
  };
  const path = operation.parameters.filter(
    (parameter) => parameter.in === "path"
  );
  const query = operation.parameters.filter(
    (parameter) => parameter.in === "query"
  );
  const parts = [
    ["path", path.map((parameter) => argument(parameter.name))],
    [
      "query",
      query.map((parameter) => argument(parameter.name, parameter.separator)),
    ],
    ["body", operation.body.map((name) => argument(name))],
  ] as const;
  const init = parts
    .filter(([, members]) => members.length > 0)
    .map(([part, members]) => `${part}: { ${members.join(", ")} }`);
  const options = init.length === 0 ? "" : `, { ${init.join(", ")} }`;
  return `api.${operation.method.toLowerCase()}(${json(operation.path)}${options})`;
};

const handlerOf = (operation: SpecOperation, indent: string): string => {
  const call = requestOf(operation);
  const takes =
    operation.parameters.length + operation.body.length > 0 ? "args" : "_args";
  const { page } = operation;
  if (page !== undefined) {
    const items = page.items.map((name) => read(name, true)).join("");
    const next =
      page.next === undefined
        ? "null"
        : `answer${page.next.map((name) => read(name, true)).join("")} ?? null`;
    return [
      `async (${takes}, api) => {`,
      `${indent}  const answer = await ${call};`,
      `${indent}  return { items: answer${items} ?? [], next: ${next} };`,
      `${indent}}`,
    ].join("\n");
  }
  if (operation.returns.kind === "null") {
    return [
      `async (${takes}, api) => {`,
      `${indent}  await ${call};`,
      `${indent}  return null;`,
      `${indent}}`,
    ].join("\n");
  }
  return `(${takes}, api) => ${call}`;
};

const toolOf = (operation: SpecOperation): string => {
  const indent = "    ";
  const returns =
    operation.page === undefined
      ? valueOf(operation.returns, indent)
      : `page(${valueOf(operation.page.item, indent)})`;
  const args = operation.args.kind === "object" ? operation.args.fields : {};
  const route = `${operation.method} ${operation.path}`;
  return [
    `  ${json(operation.name)}: tool({`,
    `${indent}description: ${json(operation.description)},`,
    `${indent}readOnly: ${String(operation.readOnly)},`,
    `${indent}scopes: ${json(operation.scopes)},`,
    `${indent}routes: [${json(route)}],`,
    `${indent}args: ${shapeOf(args, indent)},`,
    `${indent}returns: ${returns},`,
    `${indent}handler: ${handlerOf(operation, indent)},`,
    "  }),",
  ].join("\n");
};

const authOf = (auth: SpecAuth): string => {
  switch (auth.kind) {
    case "oauth2": {
      return [
        "auth.oauth2({",
        `  authorizeUrl: ${json(auth.authorizeUrl)},`,
        `  tokenUrl: ${json(auth.tokenUrl)},`,
        `  scopes: ${json(auth.scopes)},`,
        "})",
      ].join("\n");
    }
    case "apiKey": {
      return `auth.apiKey({ in: ${json(auth.in)}, name: ${json(auth.name)} })`;
    }
    case "bearer":
    case "basic": {
      return `auth.${auth.kind}()`;
    }
    default: {
      return auth satisfies never;
    }
  }
};

/** A spec's tools as source; `url` is the address it was read from. */
export const sourceOf = (spec: Spec, url: string): string => {
  const pages = spec.operations.some(
    (operation) => operation.page !== undefined
  );
  const imports = [
    ...(spec.auth === undefined ? [] : ["auth"]),
    ...(pages ? ["page"] : []),
    "tool",
    "v",
  ];
  const openapi = `{ url: ${json(url)}, sha256: ${json(spec.sha256)} }`;
  return [
    "// Generated by @grasp-os/compiler from the OpenAPI spec at `openapi.url`,",
    "// whose text hashes to `openapi.sha256`. Regeneration replaces this file:",
    "// change the connector in a file of its own.",
    "",
    `import { ${imports.join(", ")} } from "@grasp-os/sdk/connector";`,
    "",
    `export const openapi = ${openapi} as const;`,
    "",
    `export const hosts = [${json(spec.host)}];`,
    "",
    ...(spec.auth === undefined
      ? []
      : [`export const signIn = ${authOf(spec.auth)};`, ""]),
    "export const tools = {",
    ...spec.operations.map(toolOf),
    "};",
    "",
  ].join("\n");
};

/**
 * Generates a connector's tools from its vendor's spec: the source of the
 * file regeneration replaces, and the spec as read, with what it skipped.
 * It exports the spec's URL and hash (`openapi`), the host and sign-in the
 * spec names (`hosts`, `signIn`) and the tools; the connector's own file
 * adds the rest.
 */
export const generateConnector = async (
  input: string,
  url: string
): Promise<{ source: string; spec: Spec }> => {
  const spec = await readSpec(input, url);
  return { source: sourceOf(spec, url), spec };
};
