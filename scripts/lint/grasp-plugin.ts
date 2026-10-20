/**
 * Grasp's own lint rules, loaded by oxlint as a JS plugin (vite.config.ts).
 *
 * no-scrollbars: the product shows no scrollbars (apps/web/src/styles.css
 * hides them; areas still scroll). This rule stops code from bringing one
 * back: the ScrollBar part of a scroll area, or a class or selector that
 * shows or styles a bar (`findScrollbar`).
 *
 * no-old-product-name: what a client or buyer reads names the product
 * Grasp Work, never Grasp OS (GRA-143). It reads the strings and JSX text
 * of user-facing source, never comments, which are for us.
 *
 * no-unbounded-rpc-target: Cap'n Web's `RpcTarget` (in workerd, workerd's
 * own, from `cloudflare:workers`) may only be extended through a bounded
 * base (@grasp-os/shared/rpc-target), which `no-restricted-imports` holds
 * for named imports. This rule closes the other ways to reach it: a
 * namespace import, a dynamic `import()`, `createRequire`, and passing
 * either module or its `RpcTarget` on as an export: re-exported, exported
 * as a default or a declaration's value, or through a name that holds it.
 * Type-only imports and exports pass nothing on at runtime and are left
 * alone. Outside packages it also refuses a TypeScript-private or
 * -protected method, which Cap'n Web calls like any other but types hide.
 * With `reexportsOnly` (packages), only the exports are checked.
 */
import { findScrollbar } from "./no-scrollbars.ts";
import { findOldProductName } from "./old-product-name.ts";

interface Node {
  type: string;
  value?: unknown;
  name?: Node | string;
  quasis?: { value: { raw: string } }[];
  source?: Node | null;
  specifiers?: Node[];
  local?: Node;
  imported?: Node;
  declaration?: Node | null;
  declarations?: Node[];
  id?: Node | null;
  init?: Node | null;
  expression?: Node;
  expressions?: Node[];
  object?: Node;
  properties?: Node[];
  argument?: Node;
  elements?: (Node | null)[];
  consequent?: Node;
  alternate?: Node;
  left?: Node;
  right?: Node;
  arguments?: Node[];
  body?: Node | Node[];
  static?: boolean;
  accessibility?: string;
  importKind?: string;
  exportKind?: string;
}

interface Context {
  report: (report: {
    node: Node;
    messageId: string;
    data?: Record<string, string>;
  }) => void;
}

interface RuleContext extends Context {
  options: ({ reexportsOnly?: boolean } | undefined)[];
}

const noScrollbars = {
  meta: {
    type: "problem",
    docs: {
      description: "The product shows no scrollbars; don't bring one back.",
    },
    messages: {
      component:
        "No scrollbars in the product: leave out <ScrollBar>. The area still scrolls without it.",
      className:
        'No scrollbars in the product: "{{found}}" shows or styles a scrollbar. Use overflow-auto; styles.css hides every bar.',
    },
    schema: [],
  },
  create: (context: Context) => {
    const check = (node: Node, text: string): void => {
      const found = findScrollbar(text);
      if (found !== undefined) {
        context.report({ node, messageId: "className", data: { found } });
      }
    };
    return {
      JSXOpeningElement: (node: Node): void => {
        const { name } = node;
        if (
          typeof name === "object" &&
          name.type === "JSXIdentifier" &&
          name.name === "ScrollBar"
        ) {
          context.report({ node, messageId: "component" });
        }
      },
      Literal: (node: Node): void => {
        if (typeof node.value === "string") {
          check(node, node.value);
        }
      },
      TemplateLiteral: (node: Node): void => {
        for (const quasi of node.quasis ?? []) {
          check(node, quasi.value.raw);
        }
      },
    };
  },
};

const noOldProductName = {
  meta: {
    type: "problem",
    docs: {
      description: "Name the product Grasp Work in what people read.",
    },
    messages: {
      found:
        'The product is Grasp Work: "{{found}}" is its old name. Code names (grasp-os) stay as they are.',
    },
    schema: [],
  },
  create: (context: Context) => {
    const check = (node: Node, text: string): void => {
      const found = findOldProductName(text);
      if (found !== undefined) {
        context.report({ node, messageId: "found", data: { found } });
      }
    };
    return {
      Literal: (node: Node): void => {
        if (typeof node.value === "string") {
          check(node, node.value);
        }
      },
      TemplateLiteral: (node: Node): void => {
        for (const quasi of node.quasis ?? []) {
          check(node, quasi.value.raw);
        }
      },
      JSXText: (node: Node): void => {
        if (typeof node.value === "string") {
          check(node, node.value);
        }
      },
    };
  },
};

/** The modules whose `RpcTarget` a target must not extend itself. */
const rpcModules = new Set<unknown>(["capnweb", "cloudflare:workers"]);

/** Whether `node` names one of `rpcModules`, written as a string. */
const isRpcModule = (node: Node | null | undefined): boolean =>
  node?.type === "Literal" && rpcModules.has(node.value);

/** The name a specifier's part has, an identifier's or a string's. */
const nameOf = (node: Node | undefined): unknown =>
  typeof node === "object" ? (node.name ?? node.value) : undefined;

/** Whether `value` is a node of the syntax tree. */
const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "type") === "string";

/** The TypeScript nodes that wrap a value: what they hold is passed on. */
const valueWrappers = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "ParenthesizedExpression",
]);

/** The parts of `parts` that are nodes. */
const nodes = (...parts: unknown[]): Node[] => parts.filter(isNode);

/** A class's static fields' values. */
const staticValues = (node: Node): Node[] => {
  const members = isNode(node.body) ? node.body.body : undefined;
  return (Array.isArray(members) ? members : []).flatMap((member: Node) =>
    member.type === "PropertyDefinition" && member.static === true
      ? nodes(member.value)
      : []
  );
};

/** What each kind of node holds as its value (`valuesOf`). */
const valueParts: Record<string, (node: Node) => Node[]> = {
  VariableDeclaration: (node) =>
    (node.declarations ?? []).flatMap((declarator) => nodes(declarator.init)),
  ObjectExpression: (node) =>
    (node.properties ?? []).flatMap((property) =>
      nodes(
        property.type === "SpreadElement" ? property.argument : property.value
      )
    ),
  ArrayExpression: (node) => nodes(...(node.elements ?? [])),
  ConditionalExpression: (node) => nodes(node.consequent, node.alternate),
  LogicalExpression: (node) => nodes(node.left, node.right),
  AssignmentExpression: (node) => nodes(node.right),
  SequenceExpression: (node) => nodes(node.expressions?.at(-1)),
  SpreadElement: (node) => nodes(node.argument),
  CallExpression: (node) => node.arguments ?? [],
  NewExpression: (node) => node.arguments ?? [],
  ArrowFunctionExpression: (node) =>
    isNode(node.body) && node.body.type !== "BlockStatement" ? [node.body] : [],
  ClassDeclaration: staticValues,
  ClassExpression: staticValues,
};

/**
 * What `node`, as a value, may be or hold as it is: itself, what it
 * wraps, a declaration's values, an object's or array's members, either
 * side of a choice, a call's arguments (`Object.freeze(RpcTarget)`), an
 * arrow's answer, a class's static fields. Not what a function's body or
 * a class's methods use inside, which isn't followed (a class that
 * extends it is the lint's other half).
 */
const valuesOf = (node: Node): Node[] =>
  valueWrappers.has(node.type)
    ? nodes(node.expression)
    : (valueParts[node.type]?.(node) ?? []);

/**
 * The names a declaration's pattern binds: `T` of `T`, and of
 * `{ RpcTarget: T }` and `[T]` alike.
 */
const boundBy = (pattern: Node): unknown[] => {
  const names: unknown[] = [];
  const pending = [pattern];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.type === "Identifier") {
      names.push(next.name);
    } else if (next.type === "ObjectPattern") {
      for (const property of next.properties ?? []) {
        const value: unknown =
          property.type === "RestElement" ? property.argument : property.value;
        if (isNode(value)) {
          pending.push(value);
        }
      }
    } else if (next.type === "ArrayPattern") {
      pending.push(
        ...(next.elements ?? []).filter(
          (element): element is Node => element !== null
        )
      );
    } else if (next.type === "AssignmentPattern" && next.left) {
      pending.push(next.left);
    } else if (next.type === "RestElement" && next.argument) {
      pending.push(next.argument);
    }
  }
  return names;
};

/** A declaration of the module's, out of the export that wraps it. */
const unwrapped = (statement: Node): Node =>
  (statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration") &&
  statement.declaration
    ? statement.declaration
    : statement;

/** The bindings one statement of the module makes, with their values. */
const bindingsOf = (statement: Node): { name: unknown; value: Node }[] => {
  const node = unwrapped(statement);
  if (node.type === "VariableDeclaration") {
    return (node.declarations ?? []).flatMap(({ id, init }) =>
      id && init ? boundBy(id).map((name) => ({ name, value: init })) : []
    );
  }
  if (node.type === "ClassDeclaration" && node.id) {
    return [{ name: node.id.name, value: node }];
  }
  const { expression } = node;
  if (
    node.type === "ExpressionStatement" &&
    expression?.type === "AssignmentExpression" &&
    expression.left?.type === "Identifier" &&
    expression.right
  ) {
    return [{ name: expression.left.name, value: expression.right }];
  }
  return [];
};

/**
 * The names the module itself binds, and the values they hold: its
 * declarations, classes and assignments at the top level. Only these can
 * be exported; a name a function or block declares inside is another
 * binding, whatever it's called.
 */
const moduleBindings = (program: Node): { name: unknown; value: Node }[] =>
  (Array.isArray(program.body) ? program.body : []).flatMap(bindingsOf);

/**
 * Whether `node` hands out a name in `names`, or a member of one
 * (`cw.RpcTarget`): as it is, or in what it holds (`valuesOf`).
 */
const passesOn = (node: Node, names: Set<unknown>): boolean => {
  const pending = [node];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.type === "Identifier" && names.has(next.name)) {
      return true;
    }
    if (next.type === "MemberExpression" && next.object) {
      pending.push(next.object);
    } else {
      pending.push(...valuesOf(next));
    }
  }
  return false;
};

const noUnboundedRpcTarget = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Reach Cap'n Web's and workerd's RpcTarget by name only, so it can't be extended unbounded.",
    },
    messages: {
      reached:
        "Import what you need from capnweb or cloudflare:workers by name, and don't pass their RpcTarget on: a target extends it only through a bounded base (@grasp-os/shared/rpc-target).",
      createRequire:
        "No createRequire: it loads a module past the checks on what is imported.",
      hiddenMethod:
        "Cap'n Web calls a target's private and protected methods too, and type checks can't see them: use a #private method.",
    },
    schema: [
      {
        type: "object",
        properties: { reexportsOnly: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
  },
  create: (context: RuleContext) => {
    const reexportsOnly = context.options[0]?.reexportsOnly === true;
    const report = (node: Node): void => {
      context.report({ node, messageId: "reached" });
    };
    // What this file calls the RpcTarget it imported, or either module as
    // a namespace, or a name declared to hold one of them: to tell what
    // an export passes on.
    const locals = new Set<unknown>();
    // The module's own names and their values, to tell which hold a
    // local, and what each export passes on, both told once the whole
    // file is read: a name may be declared after the export that names it.
    const declared: { name: unknown; value: Node }[] = [];
    const exported: { node: Node; passes: Node[]; names: unknown[] }[] = [];
    const reexports = {
      ExportAllDeclaration: (node: Node): void => {
        if (node.exportKind !== "type" && isRpcModule(node.source)) {
          report(node);
        }
      },
      ExportNamedDeclaration: (node: Node): void => {
        if (node.exportKind === "type") {
          return;
        }
        const specifiers = (node.specifiers ?? []).filter(
          (specifier) => specifier.exportKind !== "type"
        );
        if (node.source !== null && node.source !== undefined) {
          if (
            isRpcModule(node.source) &&
            specifiers.some(
              (specifier) => nameOf(specifier.local) === "RpcTarget"
            )
          ) {
            report(node);
          }
          return;
        }
        exported.push({
          node,
          passes: node.declaration ? [node.declaration] : [],
          names: specifiers.map((specifier) => nameOf(specifier.local)),
        });
      },
      ExportDefaultDeclaration: (node: Node): void => {
        if (node.declaration) {
          exported.push({ node, passes: [node.declaration], names: [] });
        }
      },
      Program: (node: Node): void => {
        declared.push(...moduleBindings(node));
      },
      "Program:exit": (): void => {
        // A name that holds a local is one too, however many hold it on.
        let grew = true;
        while (grew) {
          grew = false;
          for (const { name, value } of declared) {
            if (!locals.has(name) && passesOn(value, locals)) {
              locals.add(name);
              grew = true;
            }
          }
        }
        for (const { node, passes, names } of exported) {
          if (
            names.some((name) => locals.has(name)) ||
            passes.some((passed) => passesOn(passed, locals))
          ) {
            report(node);
          }
        }
      },
    };
    return {
      ImportDeclaration: (node: Node): void => {
        if (node.importKind === "type" || !isRpcModule(node.source)) {
          return;
        }
        for (const specifier of node.specifiers ?? []) {
          if (specifier.importKind === "type") {
            continue;
          }
          if (specifier.type === "ImportNamespaceSpecifier") {
            // Exported, the namespace passes its RpcTarget on too.
            locals.add(nameOf(specifier.local));
            if (!reexportsOnly) {
              report(node);
            }
          } else if (nameOf(specifier.imported) === "RpcTarget") {
            locals.add(nameOf(specifier.local));
          }
        }
      },
      ...reexports,
      ...(reexportsOnly
        ? {}
        : {
            ImportExpression: (node: Node): void => {
              // A module named any other way than a plain string could be
              // one of them too.
              if (node.source?.type !== "Literal" || isRpcModule(node.source)) {
                report(node);
              }
            },
            Identifier: (node: Node): void => {
              if (node.name === "createRequire") {
                context.report({ node, messageId: "createRequire" });
              }
            },
            // A target's TypeScript-private method is as callable over
            // Cap'n Web as a public one, but hidden from the types that
            // tell which methods may hand out a target
            // (core's test/rpc-targets.test.ts). In the apps, where the
            // targets are, methods are public or #private.
            MethodDefinition: (node: Node): void => {
              if (
                node.accessibility === "private" ||
                node.accessibility === "protected"
              ) {
                context.report({ node, messageId: "hiddenMethod" });
              }
            },
          }),
    };
  },
};

export default {
  meta: { name: "grasp" },
  rules: {
    "no-unbounded-rpc-target": noUnboundedRpcTarget,
    "no-scrollbars": noScrollbars,
    "no-old-product-name": noOldProductName,
  },
};
