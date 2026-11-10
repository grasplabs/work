import { symbolicModules } from "@grasp-os/runtime/host";

import { child, children, parsed, walk } from "./syntax.ts";
import type { Node } from "./syntax.ts";

// While an App's server code doesn't register, the modules generated from
// it are stand-ins typed `any` (the SDK's `symbolicModules`): a page or
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

const calls = new Set(["CallExpression", "NewExpression"]);

const functions = new Set(["ArrowFunctionExpression", "FunctionExpression"]);

/** The names a parameter binds, however it destructures: each one's identifier. */
const boundNames = (node: Node | undefined): Node[] => {
  if (node === undefined) {
    return [];
  }
  switch (node.type) {
    case "Identifier": {
      return [node];
    }
    case "ObjectPattern": {
      return children(node, "properties").flatMap((property) =>
        boundNames(
          property.type === "RestElement"
            ? child(property, "argument")
            : child(property, "value")
        )
      );
    }
    case "ArrayPattern": {
      return children(node, "elements").flatMap((element) =>
        boundNames(element)
      );
    }
    case "AssignmentPattern": {
      return boundNames(child(node, "left"));
    }
    case "RestElement": {
      return boundNames(child(node, "argument"));
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
 * `lenient`). A file that doesn't parse has none: its compile says why.
 */
export const callbackParameters = (
  files: Readonly<Record<string, string>>
): string[] => {
  const found: string[] = [];
  for (const [path, source] of Object.entries(files)) {
    const tree = parsed(path, source);
    if (tree === undefined) {
      continue;
    }
    walk(tree.program, (node, parent, key) => {
      if (
        !functions.has(node.type) ||
        parent === undefined ||
        !calls.has(parent.type) ||
        key !== "arguments"
      ) {
        return;
      }
      for (const name of children(node, "params").flatMap(boundNames)) {
        const { line, column } = tree.at(name.start);
        found.push(`${path}:${line}:${column}`);
      }
    });
  }
  return found;
};
