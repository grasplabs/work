/**
 * Grasp's own lint rules, loaded by oxlint as a JS plugin (vite.config.ts).
 *
 * no-scrollbars: the product shows no scrollbars (apps/web/src/styles.css
 * hides them; areas still scroll). This rule stops code from bringing one
 * back: the ScrollBar part of a scroll area, or a class or selector that
 * shows or styles a bar (`findScrollbar`).
 *
 * no-unbounded-rpc-target: Cap'n Web's `RpcTarget` (in workerd, workerd's
 * own, from `cloudflare:workers`) may only be extended through a bounded
 * base (@grasp-os/shared/rpc-target), which `no-restricted-imports` holds
 * for named imports. This rule closes the other ways to reach it: a
 * namespace import, a dynamic `import()`, `createRequire`, and passing
 * either module or its `RpcTarget` on as an export. With `reexportsOnly`
 * (packages), only the exports are checked.
 */
import { findScrollbar } from "./no-scrollbars.ts";

interface Node {
  type: string;
  value?: unknown;
  name?: Node | string;
  quasis?: { value: { raw: string } }[];
  source?: Node | null;
  specifiers?: Node[];
  local?: Node;
  imported?: Node;
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

/** The modules whose `RpcTarget` a target must not extend itself. */
const rpcModules = new Set<unknown>(["capnweb", "cloudflare:workers"]);

/** Whether `node` names one of `rpcModules`, written as a string. */
const isRpcModule = (node: Node | null | undefined): boolean =>
  node?.type === "Literal" && rpcModules.has(node.value);

/** The name a specifier's part has, an identifier's or a string's. */
const nameOf = (node: Node | undefined): unknown =>
  typeof node === "object" ? (node.name ?? node.value) : undefined;

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
    // What this file calls the RpcTarget it imported, to tell a re-export.
    const locals = new Set<unknown>();
    const reexports = {
      ExportAllDeclaration: (node: Node): void => {
        if (isRpcModule(node.source)) {
          report(node);
        }
      },
      ExportNamedDeclaration: (node: Node): void => {
        const passesOn = (node.specifiers ?? []).some((specifier) =>
          node.source === null || node.source === undefined
            ? locals.has(nameOf(specifier.local))
            : isRpcModule(node.source) &&
              nameOf(specifier.local) === "RpcTarget"
        );
        if (passesOn) {
          report(node);
        }
      },
    };
    return {
      ImportDeclaration: (node: Node): void => {
        if (!isRpcModule(node.source)) {
          return;
        }
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type === "ImportNamespaceSpecifier") {
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
          }),
    };
  },
};

export default {
  meta: { name: "grasp" },
  rules: {
    "no-unbounded-rpc-target": noUnboundedRpcTarget,
    "no-scrollbars": noScrollbars,
  },
};
