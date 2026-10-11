/**
 * Grasp's own lint rules, loaded by oxlint as a JS plugin (vite.config.ts).
 *
 * no-scrollbars: the product shows no scrollbars (apps/web/src/styles.css
 * hides them; areas still scroll). This rule stops code from bringing one
 * back: the ScrollBar part of a scroll area, or a class or selector that
 * shows or styles a bar (`findScrollbar`).
 *
 * no-capnweb-namespace: Cap'n Web's `RpcTarget` may only be extended
 * through a bounded base (@grasp-os/shared/rpc-target), which
 * `no-restricted-imports` holds for named imports. This rule closes the
 * other ways to reach it: a namespace import, a dynamic `import()`, and
 * re-exporting all of Cap'n Web or its `RpcTarget`.
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
}

interface Context {
  report: (report: {
    node: Node;
    messageId: string;
    data?: Record<string, string>;
  }) => void;
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

/** Whether `node` is the module name `capnweb`, written as a string. */
const isCapnweb = (node: Node | null | undefined): boolean =>
  node?.type === "Literal" && node.value === "capnweb";

const noCapnwebNamespace = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Reach Cap'n Web by named imports only, so its RpcTarget can't be extended unbounded.",
    },
    messages: {
      reached:
        "Import what you need from capnweb by name: its RpcTarget is extended only through a bounded base (@grasp-os/shared/rpc-target).",
    },
    schema: [],
  },
  create: (context: Context) => {
    const report = (node: Node): void => {
      context.report({ node, messageId: "reached" });
    };
    return {
      ImportDeclaration: (node: Node): void => {
        if (
          isCapnweb(node.source) &&
          (node.specifiers ?? []).some(
            (specifier) => specifier.type === "ImportNamespaceSpecifier"
          )
        ) {
          report(node);
        }
      },
      ImportExpression: (node: Node): void => {
        // A module named any other way than a plain string could be it too.
        if (node.source?.type !== "Literal" || isCapnweb(node.source)) {
          report(node);
        }
      },
      ExportAllDeclaration: (node: Node): void => {
        if (isCapnweb(node.source)) {
          report(node);
        }
      },
      ExportNamedDeclaration: (node: Node): void => {
        if (
          isCapnweb(node.source) &&
          (node.specifiers ?? []).some(
            (specifier) =>
              typeof specifier.local === "object" &&
              (specifier.local.name === "RpcTarget" ||
                specifier.local.value === "RpcTarget")
          )
        ) {
          report(node);
        }
      },
    };
  },
};

export default {
  meta: { name: "grasp" },
  rules: {
    "no-capnweb-namespace": noCapnwebNamespace,
    "no-scrollbars": noScrollbars,
  },
};
