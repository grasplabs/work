import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

// Agents never answer a person's decision (GRA-624, threat model T7): the
// decision service's answer and confirmation are reached only through a
// person's session, `decisions` (decisions/rpc.ts) and the screens'
// bridge (workflows/screen-runs.ts). Agents act through an `Authority`,
// never a session; a new import of these functions anywhere else in core
// could hand one a way in. This guard fails on any such import, a
// re-export, or a namespace or dynamic import of the module that would
// reach them.

const core = path.join(import.meta.dirname, "../apps/core/src");

/** Where the decision service's answer and confirmation may be imported. */
const allowed = new Set(["decisions/rpc.ts", "workflows/screen-runs.ts"]);

/** The functions that record or confirm a person's answer. */
const guarded = ["answerDecision", "confirmDecision"];

/** Where core keeps the decision service, within its sources. */
const service = "decisions/decisions.ts";

const moduleSpecifier = /["'](?<specifier>\.{1,2}\/[^"']+)["']/u;

/** Whether `specifier`, imported from `file`, is the decision service. */
const isService = (file: string, specifier: string): boolean => {
  const resolved = path.posix.join(path.posix.dirname(file), specifier);
  return resolved === service || `${resolved}.ts` === service;
};
const statements =
  /(?:import|export)\s+(?:type\s+)?(?<clause>[^;]*?)\s+from\s+["'][^"']+["']|import\(\s*["'][^"']+["']\s*\)/gu;

/**
 * How `source`, at `file` within core's sources, reaches the guarded
 * functions: each import, re-export or namespace or dynamic import of the
 * decision service that could. None from the decision service itself.
 */
const reachesOf = (file: string, source: string): string[] => {
  if (file === service) {
    return [];
  }
  const found: string[] = [];
  for (const match of source.matchAll(statements)) {
    const [statement] = match;
    const clause = match.groups?.clause ?? "";
    const specifier = moduleSpecifier.exec(statement)?.groups?.specifier;
    if (specifier === undefined || !isService(file, specifier)) {
      continue;
    }
    const whole =
      statement.startsWith("import(") ||
      clause.includes("*") ||
      statement.startsWith("export *");
    const named = guarded.some((name) =>
      new RegExp(`\\b${name}\\b`, "u").test(clause)
    );
    if (whole || named) {
      found.push(statement.replaceAll(/\s+/gu, " "));
    }
  }
  return found;
};

/** Every TypeScript source of core, relative to its `src`. */
const sources = async (): Promise<string[]> => {
  const entries = await readdir(core, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .map((entry) => entry.split(path.sep).join("/"));
};

describe("who answers a person's decision", () => {
  it("is reached from the person's session and the screens' bridge only", async () => {
    const reached: Record<string, string[]> = {};
    for (const file of await sources()) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readFile(path.join(core, file), "utf-8");
      const found = reachesOf(file, source);
      if (found.length > 0) {
        reached[file] = found;
      }
    }

    expect(
      Object.keys(reached).filter((file) => !allowed.has(file))
    ).toStrictEqual([]);
    expect(Object.keys(reached).toSorted()).toStrictEqual([...allowed]);
  });

  it("catches each way of importing them", () => {
    const from = '"../decisions/decisions.ts"';

    expect({
      named: reachesOf(
        "agents/agent.ts",
        `import { answerDecision } from ${from};`
      ),
      renamed: reachesOf(
        "agents/agent.ts",
        `import {\n  confirmDecision as mint,\n} from ${from};`
      ),
      namespace: reachesOf(
        "agents/agent.ts",
        `import * as decisions from ${from};`
      ),
      reexported: reachesOf(
        "agents/agent.ts",
        `export { answerDecision } from ${from};`
      ),
      everything: reachesOf("agents/agent.ts", `export * from ${from};`),
      dynamic: reachesOf("agents/agent.ts", `const d = await import(${from});`),
      other: reachesOf("agents/agent.ts", `import { stillOpen } from ${from};`),
    }).toStrictEqual({
      named: [`import { answerDecision } from ${from}`],
      renamed: [`import { confirmDecision as mint, } from ${from}`],
      namespace: [`import * as decisions from ${from}`],
      reexported: [`export { answerDecision } from ${from}`],
      everything: [`export * from ${from}`],
      dynamic: [`import(${from})`],
      other: [],
    });
  });
});
