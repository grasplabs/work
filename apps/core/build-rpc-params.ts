/**
 * Writes the names each method of core's RPC targets gives its parameters
 * (src/rpc-param-names.gen.ts), by its class, then the method: what a
 * staff member's view is audited by (src/staff-audit.ts, `namedBy`), which
 * reads an ID only from a parameter named as one. Read from their source
 * with oxc's parser (oxc-parser), as the minified bundle renames every
 * parameter, so the function's own source can't say them at run time.
 * Core's `typegen` runs it, and CI refuses the file when it is stale.
 *
 * A target is a class that extends `CoreRpcTarget` (src/rpc-target.ts), or
 * a class that extends one. Its methods are the ones its prototype holds,
 * as `boundedRpcTarget` wraps them: not static ones, private ones (`#x`),
 * accessors or fields. A parameter is named by its identifier; one
 * destructured is `input`. Class names must be unique among targets, as the
 * bundle keeps them (`keep_names`, wrangler.jsonc) and the table is read by
 * them.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseSync, Visitor } from "oxc-parser";
import type {
  BindingPattern,
  Class,
  ClassElement,
  MethodDefinition,
  ParamPattern,
} from "oxc-parser";

const source = path.join(import.meta.dirname, "src");
const generatedFile = path.join(source, "rpc-param-names.gen.ts");

/** The base every target extends, directly or through another target. */
const base = "CoreRpcTarget";

/** A class as its declaration says: what it extends, and its methods. */
interface DeclaredClass {
  file: string;
  extendsName: string | null;
  methods: Map<string, string[]>;
}

/** Every TypeScript source file of core but tests, declarations and this output. */
const sourceFiles = (): string[] =>
  readdirSync(source, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".d.ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".gen.ts")
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .toSorted();

/** A parameter's name: its identifier, or `input` for one destructured. */
const paramName = (param: ParamPattern | BindingPattern): string => {
  if (param.type === "Identifier") {
    return param.name;
  }
  if (param.type === "AssignmentPattern") {
    return paramName(param.left);
  }
  if (param.type === "RestElement") {
    return paramName(param.argument);
  }
  return "input";
};

/** The name of a method's key: an identifier or a string, never computed or private. */
const keyName = (member: MethodDefinition): string | undefined => {
  const { key } = member;
  if (key.type === "Identifier") {
    return key.name;
  }
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : undefined;
};

/** The prototype methods `body` declares, each with its parameters' names. */
const methodsOf = (body: readonly ClassElement[]): Map<string, string[]> => {
  const methods = new Map<string, string[]>();
  for (const member of body) {
    // A method with a body: not an overload's signature, which has none.
    if (
      member.type === "MethodDefinition" &&
      member.kind === "method" &&
      !member.static &&
      !member.computed &&
      member.value.type !== "TSEmptyBodyFunctionExpression"
    ) {
      const name = keyName(member);
      if (name !== undefined) {
        methods.set(name, member.value.params.map(paramName));
      }
    }
  }
  return methods;
};

/** Every named class `file` declares, at any depth. */
const classesIn = (file: string): Map<string, DeclaredClass> => {
  const { program, errors } = parseSync(file, readFileSync(file, "utf-8"));
  const [error] = errors;
  if (error !== undefined) {
    throw new Error(`${file} doesn't parse: ${error.message}`);
  }
  const found = new Map<string, DeclaredClass>();
  const declared = (node: Class): void => {
    if (node.id !== null) {
      found.set(node.id.name, {
        file,
        extendsName:
          node.superClass?.type === "Identifier" ? node.superClass.name : null,
        methods: methodsOf(node.body.body),
      });
    }
  };
  new Visitor({
    ClassDeclaration: declared,
    ClassExpression: declared,
  }).visit(program);
  return found;
};

/** Core's targets: each class extending `base`, or a target, by name. */
const targetsOf = (files: readonly string[]): Map<string, DeclaredClass> => {
  const declared = new Map<string, DeclaredClass[]>();
  for (const file of files) {
    for (const [name, declaration] of classesIn(file)) {
      declared.set(name, [...(declared.get(name) ?? []), declaration]);
    }
  }
  const targets = new Map<string, DeclaredClass>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, declarations] of declared) {
      const target = declarations.find(
        ({ extendsName }) =>
          extendsName === base ||
          (extendsName !== null && targets.has(extendsName))
      );
      if (target === undefined || targets.has(name)) {
        continue;
      }
      if (declarations.length > 1) {
        throw new Error(
          `More than one class is named ${name} (${declarations.map(({ file }) => path.relative(source, file)).join(", ")}): a target's name must be its own`
        );
      }
      targets.set(name, target);
      grew = true;
    }
  }
  return targets;
};

/** The generated module's source for `targets`. */
const paramNamesSource = (targets: ReadonlyMap<string, DeclaredClass>) => {
  const classes = [...targets.keys()].toSorted().map((name) => {
    const methods = [...(targets.get(name)?.methods ?? new Map())]
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([method, params]: [string, string[]]) =>
          `    ${JSON.stringify(method)}: ${JSON.stringify(params)},`
      );
    return `  ${JSON.stringify(name)}: {\n${methods.join("\n")}\n  },`;
  });
  return `// Generated by Grasp from core's RPC targets (apps/core/build-rpc-params.ts).
// Don't edit it: \`vp run -r typegen\` makes it again, and CI refuses it stale.

import type { ParamNames } from "@grasp-os/shared/rpc-target";

/**
 * The names each method of core's RPC targets gives its parameters, by
 * its class, then the method (\`CoreRpcTarget\`, rpc-target.ts).
 */
export const rpcParamNames: ParamNames = {
${classes.join("\n")}
};
`;
};

if (import.meta.main) {
  writeFileSync(generatedFile, paramNamesSource(targetsOf(sourceFiles())));
}
