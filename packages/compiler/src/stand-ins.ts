import Babel from "@babel/standalone";
import { symbolicModules } from "@grasp-os/sdk/host";

import { parserPlugins } from "./steering.ts";

// While an App's server code doesn't register, the modules generated from
// it are stand-ins typed `any` (the SDK's `symbolicModules`): a screen or
// a workflow is checked against them for everything else, and the one
// reason the server code doesn't register is the one error. A callback
// over what a stand-in answers (`rows.map((row) => …)`) then has nothing
// to take its parameters' types from, and TypeScript says each is an
// implicit `any`: never what there is to fix. The check can't ask a type
// what it is, so it goes by where the parameter is: a callback's, passed
// straight to a call, in a check that reads a stand-in. A helper's
// untyped parameter is still reported; so is any callback's once the
// server code registers and the real references replace the stand-ins.

/** Each stand-in module, by its path among an App's files. */
const standIns: Readonly<Record<string, string>> = symbolicModules();

/** Whether `files` hold a stand-in in place of a generated module. */
export const readsStandIns = (
  files: Readonly<Record<string, string>>
): boolean =>
  Object.entries(standIns).some(
    ([path, source]) => Object.hasOwn(files, path) && files[path] === source
  );

/** What the collector reads of Babel's nodes. */
interface Node {
  type: string;
  loc?: { start: { line: number; column: number } } | null;
  name?: string;
  params?: Node[];
  arguments?: Node[];
  properties?: Node[];
  elements?: (Node | null)[];
  value?: Node;
  left?: Node;
  argument?: Node;
}

const calls = new Set([
  "CallExpression",
  "NewExpression",
  "OptionalCallExpression",
]);

/** The names a parameter binds, however it destructures: each one's identifier. */
const boundNames = (node: Node | null | undefined): Node[] => {
  if (node === null || node === undefined) {
    return [];
  }
  switch (node.type) {
    case "Identifier": {
      return [node];
    }
    case "ObjectPattern": {
      return (node.properties ?? []).flatMap((property) =>
        boundNames(
          property.type === "RestElement" ? property.argument : property.value
        )
      );
    }
    case "ArrayPattern": {
      return (node.elements ?? []).flatMap((element) => boundNames(element));
    }
    case "AssignmentPattern": {
      return boundNames(node.left);
    }
    case "RestElement": {
      return boundNames(node.argument);
    }
    default: {
      return [];
    }
  }
};

/**
 * Where, in `files` (paths relative to the App), a callback passed
 * straight to a call names its parameters, as TypeScript locates an
 * implicit `any` (`file:line:column`, 1-based): the positions a check
 * that reads stand-ins doesn't report one at (checked-build.ts
 * `lenient`). A file Babel can't parse has none: its compile says why.
 */
export const callbackParameters = (
  files: Readonly<Record<string, string>>
): string[] => {
  const found: string[] = [];
  for (const [path, source] of Object.entries(files)) {
    const collect = () => ({
      visitor: {
        "ArrowFunctionExpression|FunctionExpression": ({
          node,
          parent,
        }: {
          node: Node;
          parent: Node;
        }) => {
          if (
            !calls.has(parent.type) ||
            parent.arguments?.includes(node) !== true
          ) {
            return;
          }
          for (const name of (node.params ?? []).flatMap(boundNames)) {
            const start = name.loc?.start;
            if (start !== undefined) {
              found.push(`${path}:${start.line}:${start.column + 1}`);
            }
          }
        },
      },
    });
    try {
      Babel.transform(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        sourceType: "module",
        code: false,
        parserOpts: { plugins: parserPlugins(path) },
        plugins: [collect],
      });
    } catch {
      // Unparsed: its compile error says so.
    }
  }
  return found;
};
