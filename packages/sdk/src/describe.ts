import { parse } from "@babel/parser";
import type {
  ArrowFunctionExpression,
  CallExpression,
  ForOfStatement,
  ForStatement,
  IfStatement,
  Node,
  ObjectExpression,
} from "@babel/types";
import { messageOf } from "@grasp-os/shared/errors";
import { outlineSteps } from "@grasp-os/shared/workflows";
import type {
  OptionValue,
  OutlineNode,
  StepOutline,
  WorkflowCalls,
  WorkflowOutline,
} from "@grasp-os/shared/workflows";
import { z } from "zod";

import {
  namePattern,
  nameRule,
  optionForms,
  stepKinds,
  stepOptionSchemas,
} from "./steps.ts";
import type { OptionForm, StepMethod } from "./steps.ts";
import { WorkflowError } from "./workflow.ts";

// The outline's types are shared: core returns an outline to the web.
export type {
  BranchOutline,
  LoopOutline,
  OptionValue,
  OutlineNode,
  StepKind,
  StepOutline,
  WorkflowOutline,
} from "@grasp-os/shared/workflows";

/** Why a `literal` option written any other way can't be read. */
const literalHint = "must be a literal";
// Options with a field of their own in the outline, or no literal meaning.
const unrecordedOptions = new Set([
  "description",
  "key",
  "sideEffect",
  "locked",
]);

const sdkModule = "@grasp-os/sdk/workflow";
const supportedConstructs = "`if`/`else` and `for`/`for...of` loops";

// Keys that hold no code: positions, comments and TypeScript types.
const ignoredKeys = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
]);

const fail = (node: Node | undefined, message: string): WorkflowError =>
  new WorkflowError(
    "workflow.invalid_definition",
    node?.loc ? `Line ${node.loc.start.line}: ${message}` : message
  );

const lineOf = (node: Node): number => node.loc?.start.line ?? 0;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

const childrenOf = (node: Node): [string, Node][] =>
  Object.entries(node).flatMap(([key, value]: [string, unknown]) => {
    if (ignoredKeys.has(key)) {
      return [];
    }
    const values: unknown[] = Array.isArray(value) ? value : [value];
    return values.filter(isNode).map((child): [string, Node] => [key, child]);
  });

interface Ancestor {
  node: Node;
  /** The key of the parent that holds the child. */
  key: string;
}

/** Every node under `node` (itself included), with its ancestors. */
const visit = (
  node: Node,
  onNode: (node: Node, ancestors: Ancestor[]) => void,
  ancestors: Ancestor[] = []
): void => {
  onNode(node, ancestors);
  for (const [key, child] of childrenOf(node)) {
    visit(child, onNode, [...ancestors, { node, key }]);
  }
};

const some = (node: Node, predicate: (node: Node) => boolean): boolean => {
  let found = false;
  visit(node, (candidate) => {
    found ||= predicate(candidate);
  });
  return found;
};

/** A string, template without placeholders, number or boolean literal. */
const literalOf = (node: Node): string | number | boolean | undefined => {
  if (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral"
  ) {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const nameOf = (node: Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }
  const literal = literalOf(node);
  return typeof literal === "string" ? literal : undefined;
};

/** The SDK's typed stub of the App's bindings, which takes `env`. */
type Stub = "appFunctions";

const isStub = (name: string | undefined): name is Stub =>
  name === "appFunctions";

/** Names the workflow function binds for its steps and parameters. */
interface Bindings {
  step: string | undefined;
  /** `params` in `async (step, { params }) => …`, or what it's renamed to. */
  params: string | undefined;
  /** `env` in `async (step, { env }) => …`, or what it's renamed to. */
  env: string | undefined;
  /** The SDK's stubs the file imports, by the name it imports each as. */
  stubs: ReadonlyMap<string, Stub>;
}

const contextKeys = new Set([
  "params",
  "input",
  "runId",
  "env",
  "readAttachment",
]);
const contextHint =
  "Destructure the workflow function's context, e.g. `async (step, { params, input, env }) => …`";
const parametersHint =
  "The workflow function takes `step` and its context, without default values or computed names";
const envHint = (env: string): string =>
  `Call the App's bindings as \`${env}.NAME.method(…)\` or \`appFunctions(${env}).query(…)\`; don't keep \`${env}\`, a binding or a stub in a variable or pass it on`;
const stepHint =
  "Call the App's bindings in the step's own function, not between steps or in a function inside it (loop with `for...of` there)";

/** How to read what the workflow function's context holds, instead. */
const destructuringHints = {
  params: "Read parameters as `params.name`, without destructuring it",
  env: "Call the App's bindings as `env.NAME`, without destructuring it",
} as const;

// A default value or a computed name is code that runs with the context
// in reach, where no step shows it.
const runsCode = (node: Node): boolean =>
  node.type === "AssignmentPattern" ||
  (node.type === "ObjectProperty" && node.computed);

const bindingsOf = (
  params: Node[],
  stubs: ReadonlyMap<string, Stub>
): Bindings => {
  const [stepParam, contextParam, extra] = params;
  if (extra) {
    throw fail(extra, parametersHint);
  }
  if (stepParam && stepParam.type !== "Identifier") {
    throw fail(
      stepParam,
      "Name the workflow function's first parameter, e.g. `step`"
    );
  }
  const bindings: Bindings = {
    step: stepParam?.name,
    params: undefined,
    env: undefined,
    stubs,
  };
  if (!contextParam) {
    return bindings;
  }
  if (contextParam.type !== "ObjectPattern") {
    throw fail(contextParam, contextHint);
  }
  for (const property of contextParam.properties) {
    const key =
      property.type === "ObjectProperty" && !property.computed
        ? nameOf(property.key)
        : undefined;
    // A rest element or a computed key would hide what the workflow reads.
    if (
      property.type !== "ObjectProperty" ||
      key === undefined ||
      !contextKeys.has(key)
    ) {
      throw fail(property, contextHint);
    }
    if (key !== "params" && key !== "env") {
      continue;
    }
    if (property.value.type !== "Identifier") {
      throw fail(property, destructuringHints[key]);
    }
    bindings[key] = property.value.name;
  }
  if (some(contextParam, runsCode)) {
    throw fail(contextParam, parametersHint);
  }
  return bindings;
};

/** The parameter a node reads (`params.name`), if any. */
const paramReadOf = (bindings: Bindings, node: Node): string | undefined =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.object.name === bindings.params
    ? nameOf(node.property)
    : undefined;

const paramsIn = (bindings: Bindings, nodes: Node[]): string[] => {
  const names: string[] = [];
  for (const node of nodes) {
    visit(node, (candidate) => {
      const name = paramReadOf(bindings, candidate);
      if (name !== undefined && !names.includes(name)) {
        names.push(name);
      }
    });
  }
  return names;
};

const isStepCall = (bindings: Bindings, node: Node): node is CallExpression =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === bindings.step;

/** Whether `ancestors` end in a spot where an identifier is a name, not a use. */
const isNamePosition = (ancestors: Ancestor[]): boolean => {
  const parent = ancestors.at(-1);
  if (!parent) {
    return false;
  }
  const { node, key } = parent;
  if (node.type === "MemberExpression") {
    return key === "property" && !node.computed;
  }
  const hasKey =
    node.type === "ObjectProperty" ||
    node.type === "ObjectMethod" ||
    node.type === "ClassMethod" ||
    node.type === "ClassProperty";
  return hasKey && key === "key" && !node.computed;
};

const isObjectOfMember = (ancestor: Ancestor | undefined): boolean =>
  ancestor?.node.type === "MemberExpression" &&
  ancestor.key === "object" &&
  !ancestor.node.computed;

const isFunctionNode = (node: Node): boolean =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  node.type === "ObjectMethod" ||
  node.type === "ClassMethod";

/** Whether `ancestor` holds the one argument of a call to the SDK's `stub`. */
const isStubArgument = (
  bindings: Bindings,
  ancestor: Ancestor | undefined,
  stub: Stub
): boolean =>
  ancestor?.node.type === "CallExpression" &&
  ancestor.key === "arguments" &&
  ancestor.node.arguments.length === 1 &&
  ancestor.node.callee.type === "Identifier" &&
  bindings.stubs.get(ancestor.node.callee.name) === stub;

/** Whether `args` is the context's `env` alone, as a stub takes it. */
const isContextEnv = (bindings: Bindings, args: readonly Node[]): boolean => {
  const [only, extra] = args;
  return (
    extra === undefined &&
    only?.type === "Identifier" &&
    bindings.env !== undefined &&
    only.name === bindings.env
  );
};

/** The methods of `appFunctions(env)`: one per kind of function. */
const functionKinds: ReadonlySet<string> = new Set([
  "query",
  "mutation",
  "action",
]);

/** Whether the node `ancestors` end above is called as `node.method(…)`. */
const isMethodCalled = (ancestors: Ancestor[]): boolean => {
  const caller = ancestors.at(-2);
  return (
    isObjectOfMember(ancestors.at(-1)) &&
    caller?.node.type === "CallExpression" &&
    caller.key === "callee"
  );
};

/**
 * The binding a use of `env` calls, from the use's `ancestors`: `NAME` in
 * `env.NAME.method(…)`, `APP` in `appFunctions(env).query(…)` (or
 * `mutation`, `action`). Each is a call made where it is written.
 * Undefined for any other use (an alias, an argument, a spread, a computed
 * name, a stub that isn't called at once), which could reach a binding
 * somewhere the step list doesn't name it.
 */
const envCallOf = (
  bindings: Bindings,
  ancestors: Ancestor[]
): string | undefined => {
  const parent = ancestors.at(-1);
  if (isStubArgument(bindings, parent, "appFunctions")) {
    // Only its methods, one per kind of function: any other name is no
    // call the stub has.
    const member = ancestors.at(-2)?.node;
    return isMethodCalled(ancestors.slice(0, -1)) &&
      member?.type === "MemberExpression" &&
      functionKinds.has(nameOf(member.property) ?? "")
      ? "APP"
      : undefined;
  }
  if (parent?.node.type !== "MemberExpression" || !isObjectOfMember(parent)) {
    return undefined;
  }
  return isMethodCalled(ancestors.slice(0, -1))
    ? nameOf(parent.node.property)
    : undefined;
};

/**
 * Whether the innermost function around a node (`ancestors` end above the
 * node) is a step's own: written in the step's call, as an argument
 * (`step.do`'s function) or as an option (a decision's `ask`). Only there
 * does a binding call belong to the step that names it: a function inside
 * it could be kept and run by another step, and code between steps runs
 * in none.
 */
const inStepFunction = (bindings: Bindings, ancestors: Ancestor[]): boolean => {
  const index = ancestors.findLastIndex(({ node }) => isFunctionNode(node));
  const holder = ancestors[index - 1];
  if (index === -1 || holder === undefined) {
    return false;
  }
  if (holder.key === "arguments") {
    return isStepCall(bindings, holder.node);
  }
  const options = ancestors[index - 2];
  const call = ancestors[index - 3];
  return (
    holder.node.type === "ObjectProperty" &&
    holder.key === "value" &&
    options?.node.type === "ObjectExpression" &&
    call?.key === "arguments" &&
    isStepCall(bindings, call.node)
  );
};

/** The App's bindings `nodes` call, in source order. */
const envCallsIn = (bindings: Bindings, nodes: Node[]): string[] => {
  const names: string[] = [];
  for (const node of nodes) {
    visit(node, (candidate, ancestors) => {
      if (
        candidate.type !== "Identifier" ||
        candidate.name !== bindings.env ||
        isNamePosition(ancestors)
      ) {
        return;
      }
      const called = envCallOf(bindings, ancestors);
      if (called !== undefined && !names.includes(called)) {
        names.push(called);
      }
    });
  }
  return names;
};

// `step` may only be called as `step.method(…)`, parameters only read as
// `params.name`: passed around or destructured, their use can't be read.
const checkBindingUses = (body: Node, bindings: Bindings): void => {
  visit(body, (node, ancestors) => {
    if (node.type !== "Identifier" || isNamePosition(ancestors)) {
      return;
    }
    const parent = ancestors.at(-1);
    const grandparent = ancestors.at(-2);
    const member = isObjectOfMember(parent);
    if (node.name === bindings.step) {
      const called =
        member &&
        grandparent?.node.type === "CallExpression" &&
        grandparent.key === "callee";
      if (!called) {
        throw fail(
          node,
          `Only call steps as \`${node.name}.method(…)\`; don't pass \`${node.name}\` around`
        );
      }
    }
    if (node.name === bindings.params && !member) {
      throw fail(
        node,
        `Read parameters as \`${node.name}.name\`, so the step list shows which are used`
      );
    }
  });
};

// The context reaches the workflow's code only by the names its parameter
// list binds, and the App's bindings only as calls the step list names:
// each made where it is written, in the function of the step it is named
// under. `this` and `arguments` could read the context unseen; so could
// `env`, a binding or an SDK stub that is kept in a variable, passed on,
// spread or read by a computed name, and a call in a function inside a
// step's own could be kept there and made by another step.
//
// Every identifier of the context's `env`'s name is taken to be it: the
// file declares nothing else by that name (`checkEnvName`), so there is no
// telling two apart to get wrong.
const checkEnvUses = (body: Node, bindings: Bindings): void => {
  visit(body, (node, ancestors) => {
    if (node.type === "ThisExpression") {
      throw fail(node, "Don't use `this` in the workflow's function");
    }
    if (node.type !== "Identifier" || isNamePosition(ancestors)) {
      return;
    }
    if (node.name === "arguments") {
      throw fail(node, "Don't use `arguments` in the workflow's function");
    }
    const parent = ancestors.at(-1);
    const called =
      parent?.node.type === "CallExpression" && parent.key === "callee";
    if (bindings.stubs.has(node.name) && !called) {
      throw fail(
        node,
        `Only call \`${node.name}\`; don't rename it or pass it on`
      );
    }
    // Made only with the context's `env` itself, which the check of `env`
    // below reads: never without it, nor with anything else.
    if (
      called &&
      bindings.stubs.get(node.name) === "appFunctions" &&
      parent.node.type === "CallExpression" &&
      !isContextEnv(bindings, parent.node.arguments)
    ) {
      throw fail(node, envHint(bindings.env ?? "env"));
    }
    if (node.name !== bindings.env) {
      return;
    }
    if (envCallOf(bindings, ancestors) === undefined) {
      throw fail(node, envHint(node.name));
    }
    if (!inStepFunction(bindings, ancestors)) {
      throw fail(node, stepHint);
    }
  });
};

/** The names a declaration's pattern binds, without its defaults' code. */
const patternNames = (node: Node): string[] => {
  if (node.type === "Identifier") {
    return [node.name];
  }
  if (node.type === "ObjectPattern") {
    return node.properties.flatMap((property) =>
      patternNames(
        property.type === "ObjectProperty" ? property.value : property
      )
    );
  }
  if (node.type === "ArrayPattern") {
    return node.elements.flatMap((element) =>
      element ? patternNames(element) : []
    );
  }
  if (node.type === "RestElement") {
    return patternNames(node.argument);
  }
  return node.type === "AssignmentPattern" ? patternNames(node.left) : [];
};

// Nodes whose declarations are their own: a name declared in one isn't
// one outside it.
const scopeTypes = new Set([
  "Program",
  "BlockStatement",
  "StaticBlock",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "CatchClause",
]);

const isScope = (node: Node): boolean =>
  scopeTypes.has(node.type) || isFunctionNode(node);

/** The names a node declares in the scope around it. */
const declaredAround = (node: Node): string[] => {
  if (node.type === "VariableDeclarator") {
    return patternNames(node.id);
  }
  return (node.type === "FunctionDeclaration" ||
    node.type === "ClassDeclaration") &&
    node.id
    ? [node.id.name]
    : [];
};

/** The names a node declares for what is inside it: its parameters. */
const declaredWithin = (node: Node): string[] => {
  if (node.type === "CatchClause") {
    return node.param ? patternNames(node.param) : [];
  }
  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "ObjectMethod" ||
    node.type === "ClassMethod"
  ) {
    const named =
      node.type === "FunctionExpression" && node.id ? [node.id.name] : [];
    return [...named, ...node.params.flatMap((param) => patternNames(param))];
  }
  return [];
};

/** The names a node gives a value besides: an import, a class, TypeScript's own. */
const declaredOtherwise = (node: Node): string[] => {
  if (node.type === "ImportDeclaration") {
    return node.specifiers.map(({ local }) => local.name);
  }
  if (node.type === "TSParameterProperty") {
    return patternNames(node.parameter);
  }
  if (node.type === "TSDeclareFunction") {
    const named = node.id ? [node.id.name] : [];
    return [...named, ...node.params.flatMap((param) => patternNames(param))];
  }
  const named =
    node.type === "ClassExpression" ||
    node.type === "TSEnumDeclaration" ||
    node.type === "TSModuleDeclaration" ||
    node.type === "TSImportEqualsDeclaration";
  return named && node.id?.type === "Identifier" ? [node.id.name] : [];
};

// Nothing else in the workflow's file is named as the context's `env` is:
// no variable, parameter, catch binding, function, class or import,
// wherever it is declared. Telling a second `env` from the context's takes
// knowing exactly which scope each name is in (a `var` in a block is the
// function's, so it *is* the parameter), and a reader that gets that wrong
// once leaves a call out of the step list. With one `env` in the file,
// every identifier of that name is the context's.
const checkEnvName = (file: Node, run: Node, env: string | undefined): void => {
  if (env === undefined) {
    return;
  }
  visit(file, (node) => {
    const names = [
      ...declaredAround(node),
      ...(node === run ? [] : declaredWithin(node)),
      ...declaredOtherwise(node),
    ];
    if (names.includes(env)) {
      throw fail(
        node,
        `Name this something other than \`${env}\`, such as \`entry\` or \`item\`: in a workflow's file only the workflow function's own \`${env}\` has that name`
      );
    }
  });
};

/**
 * The names each scope of a file declares, by the scope's node; only for
 * telling what an assignment may change (`checkModuleScope`), where a name
 * wrongly taken for undeclared is refused, never let through. A `var` is
 * counted in the block it is written in, though it is its function's: a
 * use of it outside that block is then refused, which errs the safe way.
 */
const scopesOf = (file: Node): Map<Node, Set<string>> => {
  const scopes = new Map<Node, Set<string>>();
  const declare = (scope: Node | undefined, names: string[]): void => {
    if (scope === undefined || names.length === 0) {
      return;
    }
    const known = scopes.get(scope) ?? new Set<string>();
    for (const name of names) {
      known.add(name);
    }
    scopes.set(scope, known);
  };
  visit(file, (node, ancestors) => {
    // `declare const Array: …` declares a type for a name, not a variable:
    // the name is still the global.
    const parent = ancestors.at(-1)?.node;
    const typeOnly =
      (node.type === "ClassDeclaration" && node.declare === true) ||
      (parent?.type === "VariableDeclaration" && parent.declare === true);
    if (typeOnly) {
      return;
    }
    declare(
      ancestors.findLast(({ node: above }) => isScope(above))?.node,
      declaredAround(node)
    );
    declare(node, declaredWithin(node));
  });
  return scopes;
};

/** The variable an assignment's target is, or is a property of, if any. */
const rootOf = (target: Node): string | undefined => {
  if (target.type === "Identifier") {
    return target.name;
  }
  return target.type === "MemberExpression" ||
    target.type === "OptionalMemberExpression"
    ? rootOf(target.object)
    : undefined;
};

/**
 * What an assignment's left side assigns to: itself, or each target of a
 * destructuring pattern, however nested, with or without a default
 * (`({ map: Array.prototype.map = fallback, ...rest } = replacement)`).
 */
const assignedIn = (target: Node): Node[] => {
  if (target.type === "ObjectPattern") {
    return target.properties.flatMap((property) =>
      assignedIn(property.type === "ObjectProperty" ? property.value : property)
    );
  }
  if (target.type === "ArrayPattern") {
    return target.elements.flatMap((element) =>
      element ? assignedIn(element) : []
    );
  }
  if (target.type === "RestElement") {
    return assignedIn(target.argument);
  }
  return target.type === "AssignmentPattern"
    ? assignedIn(target.left)
    : [target];
};

/** What a node assigns to, deletes or counts up: the targets it changes. */
const changedBy = (node: Node): Node[] => {
  if (node.type === "AssignmentExpression") {
    return assignedIn(node.left);
  }
  // A loop over a target it doesn't declare assigns to it each time round.
  if (node.type === "ForOfStatement" || node.type === "ForInStatement") {
    return node.left.type === "VariableDeclaration"
      ? []
      : assignedIn(node.left);
  }
  if (node.type === "UpdateExpression") {
    return [node.argument];
  }
  return node.type === "UnaryExpression" && node.operator === "delete"
    ? [node.argument]
    : [];
};

// The run's own code builds its bindings with these, and a module that
// replaces one could take what it is built from: no workflow code needs
// them.
const refusedGlobals = new Set([
  "globalThis",
  "self",
  "Proxy",
  "Reflect",
  "Function",
  "eval",
]);

// Type declarations hold no code.
const typeDeclarations = new Set([
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
]);

// A module's own code, top level included, runs in the run's isolate
// before any step, where it could change what the run itself is built
// from: a built-in it replaces, or what another module exports. So it
// names no global object, replaces no built-in, and changes only what it
// declares itself.
const checkModuleScope = (file: Node): void => {
  const imported = new Set<string>();
  visit(file, (node) => {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        imported.add(specifier.local.name);
      }
    }
  });
  const scopes = scopesOf(file);
  const refuse = (node: Node, name: string): WorkflowError =>
    fail(node, `Don't use \`${name}\` in a workflow's code`);
  visit(file, (node, ancestors) => {
    if (ancestors.some(({ node: above }) => typeDeclarations.has(above.type))) {
      return;
    }
    if (
      node.type === "Identifier" &&
      refusedGlobals.has(node.name) &&
      !isNamePosition(ancestors)
    ) {
      throw refuse(node, node.name);
    }
    for (const target of changedBy(node)) {
      const root = rootOf(target);
      const declared =
        root === undefined ||
        ancestors.some(
          ({ node: above }) => scopes.get(above)?.has(root) === true
        );
      if (root === undefined || declared) {
        continue;
      }
      if (refusedGlobals.has(root)) {
        throw refuse(target, root);
      }
      throw fail(
        target,
        imported.has(root)
          ? `Don't change \`${root}\`, which is imported: a module changes only what it declares`
          : `Don't change \`${root}\`, a global: a module changes only what it declares`
      );
    }
  });
};

// Where the outline shows a parameter read: in a step's call, an `if`
// condition or a loop head.
const isShownPosition = (bindings: Bindings, ancestor: Ancestor): boolean => {
  const { node, key } = ancestor;
  if (node.type === "IfStatement") {
    return key === "test";
  }
  if (node.type === "ForOfStatement") {
    return key === "left" || key === "right";
  }
  if (node.type === "ForStatement") {
    return key === "init" || key === "test" || key === "update";
  }
  return key === "arguments" && isStepCall(bindings, node);
};

// A parameter read anywhere else (into a variable, say) could steer steps in
// ways the outline can't follow, so it's an error rather than a silent gap.
const checkParamReads = (body: Node, bindings: Bindings): void => {
  visit(body, (node, ancestors) => {
    const name = paramReadOf(bindings, node);
    if (
      name !== undefined &&
      !ancestors.some((ancestor) => isShownPosition(bindings, ancestor))
    ) {
      throw fail(
        node,
        `Read parameter "${name}" where it's used: in a step's options or function, an \`if\` condition or a loop head`
      );
    }
  });
};

/**
 * What the file imports from the SDK, by the name it imports each as: its
 * values only. A type-only import (`import type { workflow }`, or an
 * inline `type appFunctions`) is erased, so the name in the file's code is
 * something else of the file's own, never the SDK's `workflow` or a stub.
 */
const sdkImportsOf = (file: Node): Map<string, string | undefined> => {
  const imports = new Map<string, string | undefined>();
  visit(file, (node) => {
    if (
      node.type !== "ImportDeclaration" ||
      node.source.value !== sdkModule ||
      node.importKind === "type"
    ) {
      return;
    }
    for (const specifier of node.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type"
      ) {
        imports.set(specifier.local.name, nameOf(specifier.imported));
      }
    }
  });
  return imports;
};

/** Whether the file's default export is `call`, written as one, and nothing else. */
const isDefaultExport = (file: Node, call: CallExpression): boolean => {
  const exported = some(
    file,
    (node) =>
      node.type === "ExportDefaultDeclaration" && node.declaration === call
  );
  const another = some(
    file,
    (node) =>
      (node.type === "ExportDefaultDeclaration" && node.declaration !== call) ||
      (node.type === "ExportNamedDeclaration" &&
        node.specifiers.some(
          (specifier) => nameOf(specifier.exported) === "default"
        ))
  );
  return exported && !another;
};

/**
 * The workflow function: the third argument of the one `workflow` call,
 * with the SDK's stubs the file imports.
 */
const findWorkflowFunction = (
  file: Node
): { run: ArrowFunctionExpression; stubs: Map<string, Stub> } => {
  const imports = sdkImportsOf(file);
  const stubs = new Map<string, Stub>();
  for (const [local, imported] of imports) {
    if (isStub(imported)) {
      stubs.set(local, imported);
    }
  }
  const calls: CallExpression[] = [];
  visit(file, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      imports.get(node.callee.name) === "workflow"
    ) {
      calls.push(node);
    }
  });
  const [call, extra] = calls;
  if (!call || extra) {
    throw fail(
      extra,
      `Expected one call to \`workflow\` from "${sdkModule}", found ${calls.length}`
    );
  }
  // The file's default export is what runs: a workflow made some other way
  // and exported in this one's place would run under this one's step list,
  // and a file without one doesn't load as a workflow at all, so it has
  // no step list to show.
  if (!isDefaultExport(file, call)) {
    throw fail(
      call,
      "Export the workflow as the file's default: `export default workflow(…)`"
    );
  }
  const run = call.arguments.at(2);
  // An arrow function has no `this` or `arguments` of its own to read its
  // context by.
  if (run?.type !== "ArrowFunctionExpression") {
    throw fail(
      call,
      "Write the workflow's function inline, as an arrow function: the third argument of `workflow`"
    );
  }
  return { run, stubs };
};

interface Reader {
  source: string;
  bindings: Bindings;
  /** Step names seen so far; each may appear once. */
  names: Set<string>;
}

const textOf = (reader: Reader, node: Node): string =>
  reader.source.slice(node.start ?? 0, node.end ?? 0);

const hasSteps = (reader: Reader, node: Node): boolean =>
  some(node, (candidate) => isStepCall(reader.bindings, candidate));

const isStepMethod = (method: string | undefined): method is StepMethod =>
  method !== undefined && Object.hasOwn(stepOptionSchemas, method);

const stepMethodOf = (call: CallExpression): StepMethod => {
  const { callee } = call;
  const method =
    callee.type === "MemberExpression" && !callee.computed
      ? nameOf(callee.property)
      : undefined;
  if (!isStepMethod(method)) {
    throw fail(
      call,
      `\`step.${method ?? "?"}\` isn't a step; steps are ${Object.keys(stepOptionSchemas).join(", ")}`
    );
  }
  return method;
};

/** A literal, or an object of them, as written; undefined for anything else. */
const staticValueOf = (node: Node): OptionValue | undefined => {
  const literal = literalOf(node);
  if (literal !== undefined || node.type !== "ObjectExpression") {
    return literal;
  }
  const value: Record<string, OptionValue> = {};
  for (const property of node.properties) {
    const key =
      property.type === "ObjectProperty" && !property.computed
        ? nameOf(property.key)
        : undefined;
    const nested =
      property.type === "ObjectProperty" && key !== undefined
        ? staticValueOf(property.value)
        : undefined;
    if (key === undefined || nested === undefined) {
      return undefined;
    }
    value[key] = nested;
  }
  return value;
};

/** The options a step method takes, each with its schema and form. */
const optionsOfMethod = (method: StepMethod) =>
  new Map(
    Object.entries(stepOptionSchemas[method].shape).map(
      ([option, schema]: [string, z.ZodType]) => [
        option,
        { schema, form: optionForms.get(schema)?.form ?? "code" },
      ]
    )
  );

/**
 * How an option's value reads as its form asks: read (`ok`), only at run
 * time (`dynamic`), or not at all (`problem`, which says why).
 *
 * A `param` or `value` option written as neither a parameter nor
 * literals (a decision's reviewer or deadline from the run's input, say)
 * is dynamic: the outline names it as such, and the rest of the step
 * list stays readable, so every other step keeps its name and is held
 * to the review. What it holds is checked when the run gets there, and
 * the host holds it to the platform's ceilings; the review shows the
 * call as written. A `literal` option never is: the review must read it
 * (an AI step's binding, say).
 */
const optionReading = (
  { schema, form }: { schema: z.ZodType; form: OptionForm },
  value: Node,
  bindings: Bindings
): { kind: "ok" | "dynamic" } | { kind: "problem"; problem: string } => {
  if (form === "code") {
    return { kind: "ok" };
  }
  if (form !== "literal" && paramReadOf(bindings, value) !== undefined) {
    return { kind: "ok" };
  }
  const literal = form === "literal" ? literalOf(value) : staticValueOf(value);
  if (literal === undefined) {
    return form === "literal"
      ? { kind: "problem", problem: literalHint }
      : { kind: "dynamic" };
  }
  const result = schema.safeParse(literal);
  return result.success
    ? { kind: "ok" }
    : {
        kind: "problem",
        problem: `is invalid: ${z.prettifyError(result.error)}`,
      };
};

const optionOf = (
  name: string,
  property: ObjectExpression["properties"][number]
): { option: string; value: Node } => {
  const option =
    property.type === "ObjectProperty" && !property.computed
      ? nameOf(property.key)
      : undefined;
  if (property.type !== "ObjectProperty" || option === undefined) {
    throw fail(
      property,
      `Write each option of step "${name}" as \`name: value\`, without spreads or computed names`
    );
  }
  return { option, value: property.value };
};

/**
 * The options of a step call, checked against what its method takes, and
 * those it reads only at run time (`optionReading`), in source order.
 */
const readOptions = (
  reader: Reader,
  name: string,
  method: StepMethod,
  object: ObjectExpression
): { options: Map<string, Node>; dynamic: string[] } => {
  const allowed = optionsOfMethod(method);
  const options = new Map<string, Node>();
  const dynamic: string[] = [];
  for (const property of object.properties) {
    const { option, value } = optionOf(name, property);
    const allowedOption = allowed.get(option);
    if (!allowedOption) {
      throw fail(
        property,
        `\`${option}\` isn't an option of \`step.${method}\`; it takes ${[...allowed.keys()].join(", ")}`
      );
    }
    const reading = optionReading(allowedOption, value, reader.bindings);
    if (reading.kind === "problem") {
      throw fail(
        property,
        `Option \`${option}\` of step "${name}" ${reading.problem}`
      );
    }
    if (reading.kind === "dynamic") {
      dynamic.push(option);
    }
    options.set(option, value);
  }
  const sideEffect = options.get("sideEffect");
  const required = [...allowed]
    .filter(([, { schema }]) => !(schema instanceof z.ZodOptional))
    .map(([option]) => option);
  // A side effect's input is what a dry run shows it would write.
  if (sideEffect && literalOf(sideEffect) === true) {
    required.push("input");
  }
  const missing = required.filter((option) => !options.has(option));
  if (missing.length > 0) {
    throw fail(object, `Step "${name}" needs ${missing.join(", ")}`);
  }
  return { options, dynamic };
};

const literalOptions = (
  options: Map<string, Node>
): Record<string, OptionValue> => {
  const literals: Record<string, OptionValue> = {};
  for (const [option, value] of options) {
    const literal = staticValueOf(value);
    if (literal !== undefined && !unrecordedOptions.has(option)) {
      literals[option] = literal;
    }
  }
  return literals;
};

const stepNameOf = (
  reader: Reader,
  call: CallExpression,
  method: StepMethod
): string => {
  const expected = method === "do" ? 3 : 2;
  if (call.arguments.length !== expected) {
    throw fail(
      call,
      `\`step.${method}\` takes ${expected === 3 ? "a name, options and a function" : "a name and options"}`
    );
  }
  const [nameNode] = call.arguments;
  const name = nameNode ? literalOf(nameNode) : undefined;
  if (typeof name !== "string" || !namePattern.test(name)) {
    throw fail(call, `A step name is a string literal of ${nameRule}`);
  }
  if (reader.names.has(name)) {
    throw fail(
      call,
      `Step "${name}" appears twice; give each step its own name`
    );
  }
  reader.names.add(name);
  return name;
};

const describeCall = (
  reader: Reader,
  call: CallExpression,
  inLoop: boolean
): StepOutline => {
  const method = stepMethodOf(call);
  const name = stepNameOf(reader, call, method);
  const [, optionsNode] = call.arguments;
  if (optionsNode?.type !== "ObjectExpression") {
    throw fail(
      call,
      `Write the options of step "${name}" as an object literal in the call`
    );
  }
  const { options, dynamic } = readOptions(reader, name, method, optionsNode);
  const keyNode = options.get("key");
  if (inLoop && !keyNode) {
    throw fail(
      call,
      `Step "${name}" runs in a loop, so it needs a \`key\` that differs per item, e.g. \`key: item.id\``
    );
  }
  const flag = (option: string): boolean => {
    const node = options.get(option);
    return node ? literalOf(node) === true : false;
  };
  const description = options.get("description");
  const env = envCallsIn(reader.bindings, call.arguments);
  return {
    type: "step",
    name,
    kind: stepKinds[method],
    description: description ? String(literalOf(description)) : "",
    ...(keyNode ? { key: textOf(reader, keyNode) } : {}),
    sideEffect:
      method === "decision" || (method === "do" && flag("sideEffect")),
    locked: method === "do" && flag("locked"),
    params: paramsIn(reader.bindings, call.arguments),
    options: literalOptions(options),
    ...(dynamic.length === 0 ? {} : { dynamic }),
    ...(env.length === 0 ? {} : { env }),
    code: textOf(reader, call),
    line: lineOf(call),
  };
};

/** Parts of a node that run only sometimes: one side of `?:`, `&&`, `||`, `??`. */
const conditionalPartsOf = (node: Node): Node[] => {
  if (node.type === "ConditionalExpression") {
    return [node.consequent, node.alternate];
  }
  return node.type === "LogicalExpression" ? [node.right] : [];
};

// Steps in an expression, in evaluation order. Steps may not hide where the
// outline can't show them: in a nested function, another step's arguments,
// or one side of `?:`, `&&`, `||` or `??`.
const describeExpression = (
  reader: Reader,
  node: Node,
  inLoop: boolean
): StepOutline[] => {
  if (isStepCall(reader.bindings, node)) {
    const nested = node.arguments.find((argument) =>
      hasSteps(reader, argument)
    );
    if (nested) {
      throw fail(
        nested,
        "Run steps one after another, not inside another step"
      );
    }
    return [describeCall(reader, node, inLoop)];
  }
  if (isFunctionNode(node)) {
    if (hasSteps(reader, node)) {
      throw fail(
        node,
        "Run steps in the workflow's function itself, not in a nested function"
      );
    }
    return [];
  }
  const hidden = conditionalPartsOf(node).find((part) =>
    hasSteps(reader, part)
  );
  if (hidden) {
    throw fail(hidden, "Run a step that depends on a condition inside an `if`");
  }
  return childrenOf(node).flatMap(([, child]) =>
    describeExpression(reader, child, inLoop)
  );
};

// Describes a statement; passed in to the helpers for nested statements.
type DescribeStatement = (
  reader: Reader,
  node: Node,
  inLoop: boolean
) => OutlineNode[];

const describeIf = (
  reader: Reader,
  node: IfStatement,
  inLoop: boolean,
  describeBody: DescribeStatement
): OutlineNode[] => {
  if (hasSteps(reader, node.test)) {
    throw fail(node.test, "Run a step before the `if`, not in its condition");
  }
  const steps = describeBody(reader, node.consequent, inLoop);
  const otherwise = node.alternate
    ? describeBody(reader, node.alternate, inLoop)
    : [];
  const params = paramsIn(reader.bindings, [node.test]);
  // Kept when it reads a parameter, so every tunable value that steers the
  // run shows up.
  if (steps.length === 0 && otherwise.length === 0 && params.length === 0) {
    return [];
  }
  return [
    {
      type: "branch",
      condition: textOf(reader, node.test),
      params,
      steps,
      otherwise,
      line: lineOf(node),
    },
  ];
};

const describeLoop = (
  reader: Reader,
  node: ForOfStatement | ForStatement,
  describeBody: DescribeStatement
): OutlineNode[] => {
  const headParts: unknown[] =
    node.type === "ForOfStatement"
      ? [node.left, node.right]
      : [node.init, node.test, node.update];
  const head = headParts.filter(isNode);
  const inHead = head.find((part) => hasSteps(reader, part));
  if (inHead) {
    throw fail(inHead, "Run a step before the loop, not in its head");
  }
  const steps = describeBody(reader, node.body, true);
  const params = paramsIn(reader.bindings, head);
  if (steps.length === 0 && params.length === 0) {
    return [];
  }
  return [
    {
      type: "loop",
      header: reader.source.slice(node.start ?? 0, node.body.start ?? 0).trim(),
      params,
      steps,
      line: lineOf(node),
    },
  ];
};

// Statements whose steps the outline shows as they are.
const plainStatements = new Set([
  "ExpressionStatement",
  "VariableDeclaration",
  "ReturnStatement",
  "ThrowStatement",
  "EmptyStatement",
]);

const describeStatement: DescribeStatement = (reader, node, inLoop) => {
  if (node.type === "BlockStatement") {
    return node.body.flatMap((child) =>
      describeStatement(reader, child, inLoop)
    );
  }
  if (node.type === "IfStatement") {
    return describeIf(reader, node, inLoop, describeStatement);
  }
  if (node.type === "ForOfStatement" || node.type === "ForStatement") {
    return describeLoop(reader, node, describeStatement);
  }
  if (plainStatements.has(node.type)) {
    return describeExpression(reader, node, inLoop);
  }
  if (hasSteps(reader, node)) {
    throw fail(
      node,
      `Steps can sit in ${supportedConstructs} only; move this step out of the construct around it`
    );
  }
  return [];
};

const parseModule = (source: string): Node => {
  try {
    return parse(source, { sourceType: "module", plugins: ["typescript"] });
  } catch (error) {
    throw fail(undefined, `The workflow doesn't parse: ${messageOf(error)}`);
  }
};

/** The workflow function of `source` and the names it binds, its use of its context checked. */
const readContext = (
  source: string
): { run: ArrowFunctionExpression; bindings: Bindings } => {
  const file = parseModule(source);
  checkModuleScope(file);
  const { run, stubs } = findWorkflowFunction(file);
  const bindings = bindingsOf(run.params, stubs);
  checkEnvName(file, run, bindings.env);
  checkEnvUses(run.body, bindings);
  return { run, bindings };
};

/**
 * Throws when a file a workflow may import (any under `workflows/`) could
 * change, as it loads, what a run is built from: it names a global object
 * (`globalThis`, `self`) or a built-in the run's bindings are made with
 * (`Proxy`, `Reflect`, `Function`, `eval`), or assigns to anything it
 * doesn't declare itself, by destructuring too: a global, a built-in, or
 * what it imports.
 * `checkWorkflowBindings` asks the same of the workflow's own file.
 */
export const checkWorkflowModule = (source: string): void => {
  checkModuleScope(parseModule(source));
};

/**
 * Throws unless every call a workflow's code makes to the App's bindings
 * can be read from its TypeScript source, so the step list names each
 * under the step that makes it. The workflow is the file's default
 * export, made by the SDK's `workflow`, and its function an arrow
 * function that destructures its context in its parameter list: the
 * context has no other name. `env` appears only in a call made where it
 * is written, `env.NAME.method(…)` or `appFunctions(env).query(…)`, and
 * only in a step's own function
 * (`step.do`'s, or an option such as a decision's `ask`), not between
 * steps and not in a function inside it, which another step could run.
 * `this`, `arguments`, and `env`, a binding or an SDK stub that is
 * renamed, kept in a variable, passed on, spread or read by a computed
 * name are errors, and so is anything else in the file named as the
 * context's `env` is (a callback's parameter, say: rename it), and so is what `checkWorkflowModule` refuses, each
 * saying how to write it instead.
 *
 * It is the part of `describeWorkflow` that isn't about how steps are laid
 * out: a workflow that passes may still have steps that can't be read (a
 * step in a `try`, say), which a review then shows as unread.
 *
 * It reads one file's source, so it closes what that source can say, not
 * what code does as it runs: a module that reaches a built-in some other
 * way and changes it may still take a binding from a step that calls one.
 * Every binding call is checked against the App's permissions and audited
 * where it lands, in core, whatever the step list says.
 */
export const checkWorkflowBindings = (source: string): void => {
  readContext(source);
};

/**
 * Reads a workflow's steps from its TypeScript source, in source order, with
 * the `if`/`else` branches and `for`/`for...of` loops they sit in. Step
 * names and options must be written as literals in each call, so the list is
 * exactly what the code runs. Anything that can't be read that way (a step
 * inside a `switch`, `try`, `while` or nested function, options built
 * elsewhere, a step in a loop without a `key`) is an error that says how to
 * write it instead, and so is any call to the App's bindings that can't be
 * read (`checkWorkflowBindings`): each step names the bindings it calls.
 *
 * Pure JavaScript, so it runs inside workerd, e.g. when a workflow is saved.
 */
export const describeWorkflow = (source: string): WorkflowOutline => {
  const { run, bindings } = readContext(source);
  checkBindingUses(run.body, bindings);
  checkParamReads(run.body, bindings);
  const reader: Reader = { source, bindings, names: new Set() };
  const steps =
    run.body.type === "BlockStatement"
      ? describeStatement(reader, run.body, false)
      : describeExpression(reader, run.body, false);
  return { steps };
};

/**
 * `describeWorkflow`, or null when its steps can't be read. Only the
 * describer's own refusals count as unreadable: anything else it throws
 * is thrown on, so a fault in the reader never passes for a workflow it
 * refused.
 */
export const readOutline = (source: string): WorkflowOutline | null => {
  try {
    return describeWorkflow(source);
  } catch (error) {
    if (error instanceof WorkflowError) {
      return null;
    }
    throw error;
  }
};

/**
 * A workflow's AI step call (`step.llm`), wherever it sits: its name and
 * `binding` when written as literals, null otherwise.
 */
export interface AiStepCall {
  readonly name: string | null;
  readonly binding: string | null;
  readonly line: number;
}

/**
 * The scopes under `body` (itself included) that declare `name`: a
 * variable, function or class in a block, a parameter of a nested
 * function, a catch binding; a `var` in the function (or class static
 * block) it is written in.
 */
const scopesDeclaring = (body: Node, name: string): Set<Node> => {
  const scopes = new Set<Node>();
  visit(body, (node, ancestors) => {
    if (declaredWithin(node).includes(name)) {
      scopes.add(node);
    }
    if (declaredAround(node).includes(name)) {
      // A `var` is its function's, wherever it is written: in the
      // workflow function itself, it is the parameter declared again.
      const declaration = ancestors.at(-1)?.node;
      const hoisted =
        declaration?.type === "VariableDeclaration" &&
        declaration.kind === "var";
      const scope =
        ancestors.findLast(({ node: above }) =>
          hoisted
            ? isFunctionNode(above) || above.type === "StaticBlock"
            : isScope(above) || above.type === "SwitchStatement"
        )?.node ?? body;
      scopes.add(scope);
    }
  });
  return scopes;
};

/**
 * A step call's `binding` option, when written as a string literal that
 * nothing after it can replace: null when the options are no object
 * literal, spread anything in, or name a key by a computation.
 */
const bindingOption = (options: Node | undefined): string | null => {
  if (options?.type !== "ObjectExpression") {
    return null;
  }
  let binding: string | null = null;
  for (const property of options.properties) {
    if (property.type !== "ObjectProperty" || property.computed) {
      return null;
    }
    if (nameOf(property.key) === "binding") {
      const value = literalOf(property.value);
      binding = typeof value === "string" ? value : null;
    }
  }
  return binding;
};

/**
 * The AI step a use of `step` (`node`, under `ancestors`) may take, or
 * undefined for a call of another method (`aiStepCalls`).
 */
const aiStepCallOf = (
  node: Node,
  ancestors: Ancestor[]
): AiStepCall | undefined => {
  const line = node.loc?.start.line ?? 0;
  const member = ancestors.at(-1);
  const call = ancestors.at(-2)?.node;
  const method =
    member?.node.type === "MemberExpression" &&
    member.key === "object" &&
    !member.node.computed
      ? nameOf(member.node.property)
      : undefined;
  const calledNode =
    call?.type === "CallExpression" && call.callee === member?.node
      ? call
      : undefined;
  if (method === undefined || calledNode === undefined) {
    return { name: null, binding: null, line };
  }
  if (method !== "llm") {
    return undefined;
  }
  const [named, options] = calledNode.arguments;
  const name = named === undefined ? undefined : literalOf(named);
  return {
    name: typeof name === "string" ? name : null,
    binding: bindingOption(options),
    line,
  };
};

/** `node` without the types around it: `workflow(…) as X` is the call. */
const unwrapped = (node: Node | null | undefined): Node | undefined => {
  let current = node ?? undefined;
  while (
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSTypeAssertion" ||
    current?.type === "ParenthesizedExpression"
  ) {
    current = current.expression;
  }
  return current;
};

/**
 * The call of the SDK's `workflow` that `file` exports as its default:
 * the export itself, or the variable it names (`export default reader`,
 * `export { reader as default }`), initialised with that call.
 */
const exportedWorkflowCall = (file: Node): CallExpression | undefined => {
  const imports = sdkImportsOf(file);
  const isWorkflowCall = (
    node: Node | null | undefined
  ): node is CallExpression =>
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    imports.get(node.callee.name) === "workflow";
  let exported: Node | undefined;
  let named: string | undefined;
  visit(file, (node) => {
    if (node.type === "ExportDefaultDeclaration") {
      exported = unwrapped(node.declaration);
    }
    if (node.type === "ExportNamedDeclaration") {
      for (const specifier of node.specifiers) {
        if (
          specifier.type === "ExportSpecifier" &&
          nameOf(specifier.exported) === "default"
        ) {
          named = specifier.local.name;
        }
      }
    }
  });
  if (isWorkflowCall(exported)) {
    return exported;
  }
  const name = exported?.type === "Identifier" ? exported.name : named;
  // The module's own declaration of that name: one in a function or a
  // block is another variable.
  let call: CallExpression | undefined;
  visit(file, (node, ancestors) => {
    const declaration = ancestors.at(-1)?.node;
    const scope = ancestors.at(declaration === undefined ? -1 : -2)?.node;
    const inModule =
      scope?.type === "Program" ||
      (scope?.type === "ExportNamedDeclaration" &&
        ancestors.at(-3)?.node.type === "Program");
    const init =
      node.type === "VariableDeclarator" ? unwrapped(node.init) : undefined;
    if (
      inModule &&
      declaration?.type === "VariableDeclaration" &&
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === name &&
      isWorkflowCall(init)
    ) {
      call = init;
    }
  });
  return call;
};

/**
 * The workflow function's body in `source` and the name it takes its
 * runner by (`step`), read as leniently as the code allows: when its
 * context can't be read (`env` kept outside a step, a \`function\` rather
 * than an arrow), from the first parameter of the function passed to the
 * SDK's `workflow`. Undefined when there is no such name to go by: code
 * that doesn't parse, isn't written with `workflow`, or destructures its
 * runner.
 */
const runnerOf = (source: string): { body: Node; step: string } | undefined => {
  try {
    const { run, bindings } = readContext(source);
    return bindings.step === undefined
      ? undefined
      : { body: run.body, step: bindings.step };
  } catch (error) {
    if (!(error instanceof WorkflowError)) {
      throw error;
    }
  }
  let file: Node;
  try {
    file = parseModule(source);
  } catch (error) {
    if (error instanceof WorkflowError) {
      return undefined;
    }
    throw error;
  }
  // The call of the SDK's `workflow` the file exports as its default, what
  // runs, directly or through the variable it is kept in, and whose
  // function, an arrow or not, takes its runner by name.
  const call = exportedWorkflowCall(file);
  const run = call?.arguments.at(2);
  if (
    run?.type !== "ArrowFunctionExpression" &&
    run?.type !== "FunctionExpression"
  ) {
    return undefined;
  }
  const [first] = run.params;
  return first?.type === "Identifier"
    ? { body: run.body, step: first.name }
    : undefined;
};

/**
 * Every AI step the workflow in `source` may take, read from its code
 * whether or not its outline can be (`readOutline`): a step in a `try`
 * runs all the same. Any use of `step` that isn't `step.method(…)` (kept
 * in a variable, passed on, a computed method) may take one too, through
 * a model no one can read: it counts as an AI step with no `binding`.
 * When the workflow's context can't be read (`env` kept outside a step,
 * say), its runner is still its first parameter (`runnerOf`). Null when
 * there is no runner to go by: code that hides it is refused on each
 * attempt by the host, whatever this reads.
 */
export const aiStepCalls = (source: string): AiStepCall[] | null => {
  const runner = runnerOf(source);
  if (runner === undefined) {
    return null;
  }
  const { body, step } = runner;
  const shadowing = scopesDeclaring(body, step);
  const calls: AiStepCall[] = [];
  visit(body, (node, ancestors) => {
    if (
      node.type !== "Identifier" ||
      node.name !== step ||
      isNamePosition(ancestors)
    ) {
      return;
    }
    // The nearest scope around it that declares the name decides what it
    // is: one inside the workflow function is another variable; the
    // function's own body declaring it again is one no one can read.
    // A case's declarations are the cases', not the switch expression's.
    const scope = ancestors.findLast(
      ({ node: above, key }) =>
        shadowing.has(above) &&
        !(above.type === "SwitchStatement" && key === "discriminant")
    )?.node;
    if (scope !== undefined && scope !== body) {
      return;
    }
    const call =
      scope === body
        ? { name: null, binding: null, line: node.loc?.start.line ?? 0 }
        : aiStepCallOf(node, ancestors);
    if (call !== undefined) {
      calls.push(call);
    }
  });
  return calls;
};

/**
 * The App's bindings the workflow in `source` calls, as a review shows
 * them and its runs are held to: by step, as its outline names them, and
 * all together. A workflow whose steps can't be read (a step in a `try`,
 * say) still has its calls read (`checkWorkflowBindings`), and each of its
 * steps is held to all of them. When even those can't be read (a binding
 * kept in a variable, code not written with the SDK's `workflow`), it
 * calls none: no review could show one, so its runs may make none, as a
 * review then says. As with `readOutline`, only the describer's own
 * refusals count as unreadable.
 */
export const reviewedCalls = (source: string): WorkflowCalls => {
  let context: ReturnType<typeof readContext>;
  try {
    context = readContext(source);
  } catch (error) {
    if (error instanceof WorkflowError) {
      return { steps: null, all: [] };
    }
    throw error;
  }
  const { run, bindings } = context;
  const outline = readOutline(source);
  return {
    steps:
      outline === null
        ? null
        : Object.fromEntries(
            outlineSteps(outline.steps).map(({ name, env }) => [
              name,
              env ?? [],
            ])
          ),
    all: envCallsIn(bindings, [run.body]),
  };
};
