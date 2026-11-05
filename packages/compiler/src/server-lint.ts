/**
 * Lints an App's server code for what the type check can't see: a
 * mutation that reads the clock or randomness (`Date.now()`, `new
 * Date()`, `Math.random()`, `crypto.randomUUID()`), which answers
 * differently each time it runs, though a mutation may run again (its
 * reads changed under it, or a person's teams did) and should commit
 * what it would have the first time. Convex has the same rule, and
 * baseflare's codegen warns of it too. A warning, never an error: the
 * code may mean it, and the host makes nothing of it either way. Through
 * ESLint's `Linter` and the typescript-eslint parser, as screens are
 * linted (lint.ts).
 */
import * as parser from "@typescript-eslint/parser";
import type { Rule } from "eslint";
import { Linter } from "eslint/universal";

import { appCodeKind } from "./app-code.ts";
import type { Diagnostic } from "./diagnostic.ts";

/** The builders whose handlers are mutations. */
const mutationBuilders: ReadonlySet<string> = new Set([
  "mutation",
  "internalMutation",
]);

/**
 * The module server code imports its builders from: `@server/_generated/server`,
 * or `_generated/server` relative to a module under `server/`.
 */
const builderModule =
  /^(?:@server|\.\.?(?:\/\.\.)*)\/_generated\/server(?:\.ts)?$/u;

/**
 * The mutation builders a module imports from `builderModule`, by the
 * names it calls them: each named import's local name (`mutation as
 * write` is `write`) and each namespace's (`server.mutation`).
 */
interface Builders {
  readonly named: Set<string>;
  readonly namespaces: Set<string>;
}

/** `value[key]`, for an AST node read without its types. */
const get = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/** `node`'s name, when it is an identifier or a plain member's property. */
const nameOf = (node: unknown): unknown => {
  if (get(node, "type") === "Identifier") {
    return get(node, "name");
  }
  const property = get(node, "property");
  return get(node, "type") === "MemberExpression" &&
    get(property, "type") === "Identifier"
    ? get(property, "name")
    : undefined;
};

/** Whether `node` is `object.property`. */
const isMember = (node: unknown, object: string, property: string): boolean =>
  get(node, "type") === "MemberExpression" &&
  nameOf(get(node, "object")) === object &&
  nameOf(node) === property;

/** Whether `callee` calls one of the module's mutation builders. */
const isMutationBuilder = (callee: unknown, builders: Builders): boolean => {
  if (get(callee, "type") === "Identifier") {
    return builders.named.has(String(get(callee, "name")));
  }
  const object = get(callee, "object");
  return (
    get(callee, "type") === "MemberExpression" &&
    get(object, "type") === "Identifier" &&
    builders.namespaces.has(String(get(object, "name"))) &&
    mutationBuilders.has(String(nameOf(callee)))
  );
};

/** Whether `node` is inside a mutation's `handler`. */
const inMutationHandler = (node: unknown, builders: Builders): boolean => {
  for (let at = node; at !== undefined && at !== null; at = get(at, "parent")) {
    const declared = get(at, "parent");
    const call = get(declared, "parent");
    if (
      get(at, "type") === "Property" &&
      nameOf(get(at, "key")) === "handler" &&
      get(declared, "type") === "ObjectExpression" &&
      get(call, "type") === "CallExpression" &&
      isMutationBuilder(get(call, "callee"), builders)
    ) {
      return true;
    }
  }
  return false;
};

/** What `node`, a call or `new`, reads that answers differently each time. */
const unstableRead = (node: Rule.Node): string | undefined => {
  const callee = get(node, "callee");
  const args = get(node, "arguments");
  if (node.type === "NewExpression") {
    return nameOf(callee) === "Date" && Array.isArray(args) && args.length === 0
      ? "new Date()"
      : undefined;
  }
  if (isMember(callee, "Date", "now")) {
    return "Date.now()";
  }
  if (isMember(callee, "Math", "random")) {
    return "Math.random()";
  }
  const name = nameOf(callee);
  return name === "randomUUID" || name === "getRandomValues"
    ? `${name}()`
    : undefined;
};

const deterministicMutations: Rule.RuleModule = {
  meta: {
    type: "problem",
    // ESLint compiles a rule's options schema at run time, which Workers
    // forbid (lint.ts); this rule takes no options.
    schema: false,
    messages: {
      unstable:
        "{{what}} answers differently each time, and a mutation may run again: pass the time or ID in as an argument, or read the record's _createdAt.",
    },
  },
  create: (context) => {
    const builders: Builders = { named: new Set(), namespaces: new Set() };
    const check = (node: Rule.Node): void => {
      const what = unstableRead(node);
      if (what !== undefined && inMutationHandler(node, builders)) {
        context.report({ node, messageId: "unstable", data: { what } });
      }
    };
    return {
      // Every import, read before any call is checked: imports are
      // hoisted, so one written after a call still names its builder.
      Program: (program) => {
        for (const node of program.body) {
          if (
            node.type !== "ImportDeclaration" ||
            !builderModule.test(String(node.source.value))
          ) {
            continue;
          }
          for (const specifier of node.specifiers) {
            if (specifier.type === "ImportNamespaceSpecifier") {
              builders.namespaces.add(specifier.local.name);
            } else if (
              specifier.type === "ImportSpecifier" &&
              mutationBuilders.has(String(nameOf(specifier.imported)))
            ) {
              builders.named.add(specifier.local.name);
            }
          }
        }
      },
      CallExpression: check,
      NewExpression: check,
    };
  },
};

const config: Linter.Config[] = [
  {
    files: ["**/*.ts"],
    languageOptions: { parser },
    plugins: {
      grasp: { rules: { "deterministic-mutations": deterministicMutations } },
    },
    rules: { "grasp/deterministic-mutations": "warn" },
  },
];

/** The warnings of `files`' server code (`appCodeKind`: `server`). */
export const lintServerCode = (
  files: Readonly<Record<string, string>>
): Diagnostic[] => {
  const linter = new Linter();
  return Object.entries(files)
    .filter(([path]) => appCodeKind(path) === "server")
    .flatMap(([path, source]) =>
      linter
        .verify(source, config, path)
        // What doesn't parse, the build says where (compile.ts).
        .filter((message) => message.fatal !== true)
        .map((message): Diagnostic => ({
          file: path,
          line: message.line,
          column: message.column,
          rule: message.ruleId ?? "lint",
          severity: "warning",
          message: message.message,
        }))
    );
};
