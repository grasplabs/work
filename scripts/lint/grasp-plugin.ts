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
 *
 * no-slow-motion: Grasp answers within 300 ms (AGENTS.md, Design). It
 * reads the durations of motion only: a class list's `duration-*`, a
 * Motion `transition` (in seconds, as a `transition` prop or option, or
 * the options of Motion's `animate()`), and the Web Animations API's
 * `element.animate()` (in milliseconds, as an option or bare). It refuses
 * one over 300 ms, unless it repeats for ever (work still going on:
 * `repeat: Infinity` or `Number.POSITIVE_INFINITY`). Any other `duration`,
 * such as how long a toast stays, is not motion and passes. What is rare
 * or seen once is turned off for its files in vite.config.ts, each with
 * its reason; a stylesheet's own animations are for review.
 *
 * no-unexplained-json: in a connector, `v.json()` lets any JSON value
 * through, so the agent and Apps learn nothing of its shape (GRA-2330).
 * It refuses a call of `json` on a `v` imported under any name, or read
 * off a namespace import, unless a comment beside it says why the shape
 * is free-form (a vendor's custom fields): on lines of its own, ending on
 * the line right before the call, or before the property that holds it
 * (outside an object, its statement) or one around it that starts on the
 * same line. A comment after code on its line explains nothing: it would
 * stand before whatever comes next, and no-inline-comments refuses it
 * anyway. A comment with no words, or a tool's directive (`eslint`,
 * `oxlint`, `@ts-`, `oxfmt-ignore`, `prettier-ignore`), is no such
 * comment, but one may stand between the explanation and the code. What
 * the OpenAPI generator writes (`tools.gen.ts`) is never linted: it
 * writes `v.json()` only where the spec gives the value no shape `v` can
 * hold.
 *
 * no-class-strings: apps/web has no Tailwind, so a class list written in
 * its JSX styles nothing. It refuses a `className` (or `class`) that holds
 * class names as text: a string, a template's own text or what it puts
 * in, an array's element, either branch of a condition, or a call's
 * argument or what it is called on (`cn("…")`, `["…"].join(" ")`), through
 * TypeScript's wrappers. Spaces alone name nothing (a `join(" ")`), and a class name
 * StyleX made (`stylex.props(…).className`) is no text, so both pass, as
 * does `{...stylex.props(…)}`.
 *
 * no-inline-styles: refuses an inline style object (`style={{ … }}`) and
 * a `style` the lint can't read as a fixed one, with the component
 * linter's own messages and options, except for a component's `style`
 * given StyleX styles alone, the way a page places a Damsko component and
 * a component of its own passes that placement on (Damsko's
 * `LayoutStyle`, StyleX styles of layout properties). The linter reads no
 * types, so what counts is what the file shows can be nothing else
 * (layout-style.ts, whose header has the whole list): a member of a const
 * StyleX's `create` made, here or in a styles module of an app
 * (`styles.ts`, `*.styles.ts`, `*-styles.ts` under `apps/`, whose exports
 * the rule holds to StyleX styles), a parameter declared `LayoutStyle`,
 * what `satisfies LayoutStyle`, and arrays and conditions of them. An
 * object literal never is. Such styles go only to Damsko's components,
 * the feature's own and the file's: never to an element of the page
 * (`div`, which takes `stylex.props`) or a component of another package
 * (the kit's, the router's `Link`), whose `style` is an inline style.
 */
import shadcnLint from "@shadcn/lint";

import {
  isPlacement,
  isStylesModule,
  stylesModuleExports,
  takesStylex,
} from "./layout-style.ts";
import type { StyleContext, StyleNode } from "./layout-style.ts";
import { findScrollbar } from "./no-scrollbars.ts";
import { findOldProductName } from "./old-product-name.ts";
import { durationMs, findSlowClass, LIMIT_MS } from "./slow-motion.ts";
import type { MotionUnit } from "./slow-motion.ts";

interface Node {
  type: string;
  value?: unknown;
  name?: Node | string;
  quasis?: { value: { raw: string; cooked?: string | null } }[];
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
  key?: Node;
  parent?: Node;
  callee?: Node;
  property?: Node;
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
  loc?: Lines;
}

/** The lines a node, token or comment starts and ends on. */
interface Lines {
  start: { line: number };
  end: { line: number };
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
        'No scrollbars in the product: "{{found}}" shows or styles a scrollbar. Let it overflow with `auto`; styles.css hides every bar.',
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
        // What it reads as, escapes and all; a tagged template's invalid
        // escape has no cooked value, so its raw text then.
        for (const { value } of node.quasis ?? []) {
          check(node, value.cooked ?? value.raw);
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

/** A token or a comment, as the source code gives it. */
interface Token {
  value: string;
  loc: Lines;
}

interface Scope {
  set: Map<string, { defs: { type: string; node: Node }[] }>;
  upper: Scope | null;
}

interface JsonContext extends Context {
  sourceCode: {
    getScope: (node: Node) => Scope;
    getCommentsBefore: (of: Node) => Token[];
    getTokenBefore: (
      of: Token,
      options: { includeComments: true }
    ) => Token | null;
  };
}

/** A comment for a tool, which says nothing of a shape. */
const toolDirective =
  /^[\s*]*(?:(?:eslint|oxlint)\b|@ts-|oxfmt-ignore|prettier-ignore)/u;

/** A comment with words in it: not only spaces and a doc comment's stars. */
const hasWords = /[^\s*]/u;

/** The statement lists, whose members are the statements a comment stands before. */
const statementLists = new Set([
  "Program",
  "BlockStatement",
  "StaticBlock",
  "SwitchCase",
]);

/** Whether `node` is a property, a class's field or a statement, with the export that wraps it. */
const isHolder = (node: Node): boolean =>
  node.type === "Property" ||
  node.type === "PropertyDefinition" ||
  statementLists.has(node.parent?.type ?? "");

/**
 * What a comment explaining `call` may stand before: the call, the nearest
 * property or statement that holds it, and those around that one which
 * start on its line, up to the statement.
 */
const holdersOf = (call: Node): Node[] => {
  const holders = [call];
  let line: number | undefined;
  for (let node = call.parent; node !== undefined; node = node.parent) {
    if (!isHolder(node)) {
      continue;
    }
    line ??= node.loc?.start.line;
    if (node.loc?.start.line !== line) {
      break;
    }
    holders.push(node);
    if (statementLists.has(node.parent?.type ?? "")) {
      break;
    }
  }
  return holders;
};

/** The import specifier that binds `node`, an identifier, where one does. */
const importOf = (
  context: JsonContext,
  node: Node | undefined
): Node | undefined => {
  if (node?.type !== "Identifier" || typeof node.name !== "string") {
    return undefined;
  }
  for (
    let scope: Scope | null = context.sourceCode.getScope(node);
    scope !== null;
    scope = scope.upper
  ) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) {
      const [definition] = variable.defs;
      return definition?.type === "ImportBinding" ? definition.node : undefined;
    }
  }
  return undefined;
};

/** Whether `node` is an imported `v`, by any name, or a namespace's `v`. */
const isV = (context: JsonContext, node: Node | undefined): boolean => {
  if (node?.type === "MemberExpression") {
    return (
      nameOf(node.property) === "v" &&
      importOf(context, node.object)?.type === "ImportNamespaceSpecifier"
    );
  }
  const specifier = importOf(context, node);
  return (
    specifier?.type === "ImportSpecifier" && nameOf(specifier.imported) === "v"
  );
};

const noUnexplainedJson = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Type a connector's values with v, or say why one is free-form.",
    },
    messages: {
      free: "v.json() takes any JSON value, so the agent and Apps learn nothing of its shape. Type it with v, or, where the vendor gives it no fixed shape (custom fields), say why in a comment on the line before its property.",
    },
    schema: [],
  },
  create: (context: JsonContext) => {
    const { sourceCode } = context;
    const explains = ({ value }: Token): boolean =>
      hasWords.test(value) && !toolDirective.test(value);
    // The comments right before `node`, each on lines of its own and
    // ending on the line before the next, read back from `node` until one
    // explains it.
    const leads = (node: Node): boolean => {
      let line = node.loc?.start.line;
      for (const comment of sourceCode.getCommentsBefore(node).toReversed()) {
        const before = sourceCode.getTokenBefore(comment, {
          includeComments: true,
        });
        if (
          comment.loc.end.line + 1 !== line ||
          (before !== null && before.loc.end.line >= comment.loc.start.line)
        ) {
          return false;
        }
        if (explains(comment)) {
          return true;
        }
        ({ line } = comment.loc.start);
      }
      return false;
    };
    return {
      CallExpression: (node: Node): void => {
        const { callee } = node;
        if (
          callee?.type !== "MemberExpression" ||
          nameOf(callee.property) !== "json" ||
          !isV(context, callee.object)
        ) {
          return;
        }
        if (!holdersOf(node).some(leads)) {
          context.report({ node, messageId: "free" });
        }
      },
    };
  },
};

/** Whether `node` is infinity: `Infinity`, or `Number.POSITIVE_INFINITY`. */
const isInfinity = (node: Node): boolean =>
  node.type === "MemberExpression"
    ? nameOf(node.object) === "Number" &&
      nameOf(node.property) === "POSITIVE_INFINITY"
    : nameOf(node) === "Infinity";

/** Whether an options object repeats for ever, as work still going on does. */
const repeatsForever = (object: Node): boolean =>
  (object.properties ?? []).some(
    (each) =>
      nameOf(each.key) === "repeat" &&
      isNode(each.value) &&
      isInfinity(each.value)
  );

/** The name of what a call calls: `animate` for `animate(...)` and `el.animate(...)`. */
const calleeName = (call: Node): unknown =>
  call.callee?.type === "MemberExpression"
    ? nameOf(call.callee.property)
    : nameOf(call.callee);

/** Whether `call` is the Web Animations API's `element.animate(keyframes, …)`. */
const isElementAnimate = (call: Node): boolean =>
  call.callee?.type === "MemberExpression" && calleeName(call) === "animate";

/**
 * The unit of the motion an options object sets, or undefined when it
 * sets no motion: Motion's `transition` (a prop, a key, or the options of
 * its `animate(target, keyframes, options)`) in seconds; the Web
 * Animations API's `element.animate(keyframes, options)` in milliseconds.
 * A `transition` nests (`transition={{ scale: { duration } }}`), so the
 * object's parents up to it count.
 */
const motionUnit = (object: Node): MotionUnit | undefined => {
  let node: Node = object;
  while (node.parent !== undefined) {
    const { parent } = node;
    if (parent.type === "JSXExpressionContainer") {
      const attribute = parent.parent;
      return attribute?.type === "JSXAttribute" &&
        typeof attribute.name === "object" &&
        nameOf(attribute.name) === "transition"
        ? "s"
        : undefined;
    }
    if (parent.type === "CallExpression") {
      const args = parent.arguments ?? [];
      if (calleeName(parent) !== "animate") {
        return undefined;
      }
      if (isElementAnimate(parent) && args[1] === node) {
        return "ms";
      }
      return args[2] === node ? "s" : undefined;
    }
    if (parent.type === "Property" && nameOf(parent.key) === "transition") {
      return "s";
    }
    if (
      parent.type !== "Property" &&
      parent.type !== "ObjectExpression" &&
      parent.type !== "ConditionalExpression"
    ) {
      return undefined;
    }
    node = parent;
  }
  return undefined;
};

/** Whether `text` names a class: anything but spaces, such as the one a join puts between names. */
const namesClass = (text: string): boolean => text.trim() !== "";

/** What each kind of expression makes its class list of. */
const partsOf: Record<string, (node: Node) => unknown[]> = {
  TemplateLiteral: (node) => node.expressions ?? [],
  ArrayExpression: (node) => node.elements ?? [],
  MemberExpression: (node) => [node.object],
  JSXExpressionContainer: (node) => [node.expression],
  ConditionalExpression: (node) => [node.consequent, node.alternate],
  LogicalExpression: (node) => [node.left, node.right],
  CallExpression: (node) => [node.callee, ...(node.arguments ?? [])],
};

/** Whether `node` holds class names as text: a string, a template's own text, or either in what it is made of. */
const holdsText = (node: Node): boolean => {
  if (valueWrappers.has(node.type)) {
    return isNode(node.expression) && holdsText(node.expression);
  }
  if (node.type === "Literal") {
    return typeof node.value === "string" && namesClass(node.value);
  }
  if (
    node.type === "TemplateLiteral" &&
    (node.quasis ?? []).some((quasi) => namesClass(quasi.value.raw))
  ) {
    return true;
  }
  return nodes(...(partsOf[node.type]?.(node) ?? [])).some((part) =>
    holdsText(part)
  );
};

const noClassStrings = {
  meta: {
    type: "problem",
    docs: {
      description:
        "apps/web has no Tailwind: a class list styles nothing; style with StyleX.",
    },
    messages: {
      found:
        "apps/web has no Tailwind, so this class list styles nothing: place a Damsko component through its style prop, or style an element with {...stylex.props(…)} and Damsko's tokens.",
    },
    schema: [],
  },
  create: (context: Context) => ({
    JSXAttribute: (node: Node): void => {
      const name =
        typeof node.name === "object" ? nameOf(node.name) : undefined;
      if (
        (name === "className" || name === "class") &&
        isNode(node.value) &&
        holdsText(node.value)
      ) {
        context.report({ node, messageId: "found" });
      }
    },
  }),
};

const noSlowMotion = {
  meta: {
    type: "problem",
    docs: {
      description: "Every answer of the interface is over within 300 ms.",
    },
    messages: {
      slow: "{{ms}} ms is longer than an answer may take ({{limit}} ms). Shorten it, or, if it is rare or seen once, turn the rule off for its file in vite.config.ts with the reason.",
      unread:
        "`{{value}}` comes to no time the lint can work out. Write it as a time, or, if it follows something such as a swipe, turn the rule off for its file in vite.config.ts with the reason.",
    },
    schema: [],
  },
  create: (context: Context) => {
    const report = (node: Node, ms: number): void => {
      context.report({
        node,
        messageId: "slow",
        data: { ms: String(ms), limit: String(LIMIT_MS) },
      });
    };
    const check = (node: Node, text: string): void => {
      const found = findSlowClass(text);
      if (found === undefined) {
        return;
      }
      if ("ms" in found) {
        report(node, found.ms);
      } else {
        context.report({
          node,
          messageId: "unread",
          data: { value: found.unread },
        });
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
      // The Web Animations API also takes its duration bare, in ms:
      // `element.animate(keyframes, 600)`.
      CallExpression: (node: Node): void => {
        const [, timing] = node.arguments ?? [];
        if (
          isElementAnimate(node) &&
          timing?.type === "Literal" &&
          typeof timing.value === "number" &&
          timing.value > LIMIT_MS
        ) {
          report(timing, timing.value);
        }
      },
      ObjectExpression: (node: Node): void => {
        const unit = motionUnit(node);
        if (unit === undefined || repeatsForever(node)) {
          return;
        }
        for (const each of node.properties ?? []) {
          const { value } = each;
          if (
            nameOf(each.key) === "duration" &&
            isNode(value) &&
            value.type === "Literal" &&
            typeof value.value === "number" &&
            durationMs(value.value, unit) > LIMIT_MS
          ) {
            report(each, durationMs(value.value, unit));
          }
        }
      },
    };
  },
};

const shadcnInlineStyles = shadcnLint.rules["no-inline-styles"];

/** The name a JSX element's name starts with: `Sidebar` of `Sidebar.Item`. */
const rootName = (name: Node | string | undefined): unknown => {
  if (typeof name !== "object") {
    return name;
  }
  return name.type === "JSXMemberExpression"
    ? rootName(name.object)
    : nameOf(name);
};

/** Whether a JSX element is a component, not an element of the page (`div`). */
const isComponent = (name: Node | string | undefined): boolean => {
  if (typeof name !== "object") {
    return false;
  }
  if (name.type === "JSXMemberExpression") {
    return true;
  }
  const first = rootName(name);
  return typeof first === "string" && /^[A-Z]/u.test(first);
};

const noInlineStyles = {
  meta: {
    ...shadcnInlineStyles.meta,
    messages: {
      ...shadcnInlineStyles.meta.messages,
      stylexStyle:
        "StyleX styles reach an element through {...stylex.props(…)}, and a component only through a style prop it types as Damsko's LayoutStyle: not this one, whose style is an inline style.",
      stylesModule:
        "A styles module (styles.ts, *.styles.ts, *-styles.ts) exports only consts made by StyleX's create, so a page can place a component with what it imports from here: move this elsewhere.",
    },
  },
  create: (context: StyleContext & Context) => {
    const inline = shadcnInlineStyles.create(context);
    // Without its JSX visitors, the component linter's rule refused its
    // options and reports that itself.
    if (!("JSXAttribute" in inline)) {
      return inline;
    }
    return {
      ...inline,
      ...(isStylesModule(context.filename)
        ? {
            Program: (node: StyleNode): void => {
              for (const refused of stylesModuleExports(node, context)) {
                context.report({ node: refused, messageId: "stylesModule" });
              }
            },
          }
        : {}),
      JSXAttribute: (node: Node): void => {
        const element = node.parent?.name;
        const { value } = node;
        if (
          rootName(node.name) === "style" &&
          isNode(value) &&
          value.type === "JSXExpressionContainer" &&
          isPlacement(value.expression, context)
        ) {
          if (
            !isComponent(element) ||
            typeof element !== "object" ||
            !takesStylex(element, context)
          ) {
            context.report({ node, messageId: "stylexStyle" });
          }
          return;
        }
        inline.JSXAttribute(node);
      },
    };
  },
};

export default {
  meta: { name: "grasp" },
  rules: {
    "no-inline-styles": noInlineStyles,
    "no-unbounded-rpc-target": noUnboundedRpcTarget,
    "no-scrollbars": noScrollbars,
    "no-old-product-name": noOldProductName,
    "no-slow-motion": noSlowMotion,
    "no-class-strings": noClassStrings,
    "no-unexplained-json": noUnexplainedJson,
  },
};
