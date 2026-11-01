import { describe, expect, it } from "vite-plus/test";

import { agentApis } from "../src/agent-apis.ts";

// What the chat's model reads of each API (agent.ts `apisSection`): members
// of one `interface Env`, written by hand as text, so nothing type-checks
// them. A member left half removed reads to the model as code that doesn't
// parse, and closes the interface early for every API after it.

const openers: Readonly<Record<string, string>> = {
  "}": "{",
  ")": "(",
  "]": "[",
};

/** `text` without its comments and the contents of its string literals. */
const codeOf = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/\/\/[^\n]*/gu, "")
    .replaceAll(
      /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/gu,
      '""'
    );

/** Where `text`'s brackets don't pair up, or null when every one does. */
const unbalanced = (text: string): string | null => {
  const open: string[] = [];
  for (const char of codeOf(text)) {
    if (char === "{" || char === "(" || char === "[") {
      open.push(char);
    } else if (Object.hasOwn(openers, char) && open.pop() !== openers[char]) {
      return `an unmatched ${char}`;
    }
  }
  return open.length === 0 ? null : `${open.length} left open`;
};

describe("the APIs a chat's code calls", () => {
  it("each declare members whose brackets pair up, as the model reads them", () => {
    expect(
      agentApis.flatMap(({ name, declaration, types }) => {
        const problems = [
          [declaration, unbalanced(declaration)],
          [types, types === undefined ? null : unbalanced(types)],
        ] as const;
        return problems.flatMap(([, problem]) =>
          problem === null ? [] : [`${name}: ${problem}`]
        );
      })
    ).toStrictEqual([]);
  });
});
