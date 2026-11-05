import { appLimits } from "@grasp-os/shared/app-limits";
import type { ESLint, Rule } from "eslint";
import { Linter } from "eslint/universal";
import { describe, expect, test } from "vite-plus/test";

import { oxcWasmModule } from "../oxc-wasm/wasm.ts";
import {
  commentsOf,
  parser,
  startOxcParser,
  unparsableMessage,
} from "./eslint-parser.ts";
import { asEslint } from "./lint-comments.ts";
import { oxcOf } from "./oxc.ts";

// The lint isolate's ESLint parser (eslint-parser.ts), on oxc.wasm as the
// isolate starts it: what ESLint reads of a file, where it is, and what a
// file it can't read says.

startOxcParser(oxcOf(await oxcWasmModule(), { lint: {}, format: {} }).parse);

/** A rule that reports every node of `type`, with its value and range. */
const reporting = (type: string): ESLint.Plugin => ({
  rules: {
    each: {
      meta: { schema: false },
      create: (context) => ({
        [type]: (node: Rule.Node) => {
          context.report({
            node,
            message: `${String(Reflect.get(node, "value"))} ${node.range?.join("-") ?? ""}`,
          });
        },
      }),
    },
  },
});

/** What ESLint says of `code` (`file`), with `type`'s nodes reported. */
const verify = (code: string, type = "Program", file = "a.tsx") =>
  new Linter()
    .verify(
      code,
      [
        {
          files: ["**/*.ts", "**/*.tsx"],
          languageOptions: { parser },
          plugins: { probe: reporting(type) },
          rules: { "probe/each": "error" },
        },
      ],
      file
    )
    .map(({ line, column, endLine, endColumn, message, fatal }) => ({
      line,
      column,
      endLine,
      endColumn,
      message,
      ...(fatal === true ? { fatal } : {}),
    }));

/** An array nested `depth` deep, after a disable comment. */
const deep = (depth: number): string =>
  `// oxlint-disable-next-line no-console\nexport const deep = ${"[".repeat(depth)}${"]".repeat(depth)};\n`;

/** One record of a file of data. */
const record = (at: number): string =>
  `export const item${at} = { id: "abcdefgh", n: 12345, tags: ["a", "b"] };\n`;

/** About `characters` of data, as a file of records has it. */
const data = (characters: number): string =>
  Array.from({ length: Math.ceil(characters / record(0).length) }, (_, at) =>
    record(at)
  ).join("");

describe("what ESLint reads of a file", () => {
  test("places nodes after characters outside ASCII, a CRLF and an emoji, by UTF-16 code units", () => {
    const code =
      'const é = "😀";\r\n// ü 😀\r\nexport const b = <p>😀{é}</p>;\r\n';

    expect(verify(code, "JSXElement")).toStrictEqual([
      {
        line: 3,
        column: 18,
        endLine: 3,
        endColumn: 30,
        message: `undefined ${code.indexOf("<p>")}-${code.indexOf(";\r\n", code.indexOf("<p>"))}`,
      },
    ]);
    expect(commentsOf("a.tsx", code)).toStrictEqual([
      {
        type: "Line",
        value: " ü 😀",
        range: [code.indexOf("//"), code.indexOf("\r\n", code.indexOf("//"))],
      },
    ]);
  });

  test("says where a file stops parsing, past characters outside ASCII", () => {
    expect(verify('const é = "😀😀";\nconst = ;\n')).toStrictEqual([
      {
        line: 2,
        column: 7,
        endLine: undefined,
        endColumn: undefined,
        message: "Parsing error: Unexpected token",
        fatal: true,
      },
    ]);
  });

  test("gives a regular expression and a BigInt literal their values", () => {
    expect(
      verify("export const r = /a+/u;\nexport const n = 12n;\n", "Literal").map(
        ({ message }) => message
      )
    ).toStrictEqual(["/a+/u 17-22", "12 41-44"]);
  });
});

describe("a file too large or nested too deep to read", () => {
  test("parses whole at an App's largest file of data", () => {
    const code = data(appLimits.fileLength);

    expect({
      size: code.length >= appLimits.fileLength,
      found: verify(code),
    }).toStrictEqual({
      size: true,
      found: [
        {
          line: 1,
          column: 1,
          endLine: code.split("\n").length,
          endColumn: 1,
          message: `undefined 0-${code.length}`,
        },
      ],
    });
  });

  test("says to split it, whether it is too large or too deep, and its disable comments are none", () => {
    const larger = data(1_000_000);
    const deeper = deep(20_000);

    expect({
      larger: verify(larger, "Program", "a.ts").map(({ message }) => message),
      deeper: verify(deeper, "Program", "a.ts").map(({ message }) => message),
      comments: commentsOf("a.ts", deeper),
      read: asEslint("a.ts", deeper).text === deeper,
    }).toStrictEqual({
      larger: [`Parsing error: ${unparsableMessage}`],
      deeper: [`Parsing error: ${unparsableMessage}`],
      comments: [],
      read: true,
    });
  });

  test("reads one nested a hundred deep", () => {
    expect(
      verify(deep(100), "Program", "a.ts").map(({ message }) => message)
    ).toHaveLength(1);
  });
});
