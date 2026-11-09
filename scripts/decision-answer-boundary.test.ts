import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vite-plus/test";

// Agents never answer a person's decision (GRA-624, threat model T7): the
// decision service's answer and confirmation are reached only through a
// person's session, `decisions` (decisions/rpc.ts) and the pages'
// bridge (workflows/page-decisions.ts). Agents act through an `Authority`,
// never a session; a new import of these functions anywhere else in core
// could hand one a way in. This guard fails on any such import, a
// re-export, or a namespace or dynamic import of the module that would
// reach them.

const core = path.join(import.meta.dirname, "../apps/core/src");

/**
 * Where the decision service's answer and confirmation may be imported:
 * the person's session, and the pages' bridge, which answers for the
 * person with the page open (`appFor`) and is called from
 * pages-rpc.ts alone.
 */
const allowed = new Set(["decisions/rpc.ts", "workflows/page-decisions.ts"]);

/** The functions that record or confirm a person's answer. */
const guarded = new Set(["answerDecision", "confirmDecision"]);

/** Where core keeps the decision service, within its sources. */
const service = "decisions/decisions.ts";

/** Whether `specifier`, imported from `file`, is the decision service. */
const isService = (file: string, specifier: string): boolean => {
  if (!specifier.startsWith(".")) {
    return false;
  }
  const resolved = path.posix.join(path.posix.dirname(file), specifier);
  return resolved === service || `${resolved}.ts` === service;
};

/** The one kind of import or re-export that takes names one by one: any other takes the module whole. */
const byName: ReadonlySet<string> = new Set(["Name"]);

/** A statement's text, as one line, without its semicolon. */
const statementAt = (source: string, start: number, end: number): string =>
  source.slice(start, end).replaceAll(/\s+/gu, " ").replace(/;$/u, "");

/** A string literal's value, or undefined for any other expression. */
const literalValue = (written: string): string | undefined =>
  /^["'`](?<value>[^"'`]*)["'`]$/u.exec(written.trim())?.groups?.value;

/**
 * How `source`, at `file` within core's sources, reaches the guarded
 * functions, as oxc parses its module: each import, re-export or
 * namespace or dynamic import of the decision service that could. Type-only
 * ones too, as written. None from the decision service itself.
 */
const reachesOf = (file: string, source: string): string[] => {
  if (file === service) {
    return [];
  }
  const { module, errors } = parseSync(file, source);
  if (errors.length > 0) {
    throw new Error(`${file} doesn't parse: ${errors[0]?.message ?? ""}`);
  }
  const imports = module.staticImports.flatMap(
    ({ start, end, moduleRequest, entries }) =>
      isService(file, moduleRequest.value) &&
      entries.some(
        ({ importName }) =>
          !byName.has(importName.kind) || guarded.has(importName.name ?? "")
      )
        ? [statementAt(source, start, end)]
        : []
  );
  const exports = module.staticExports.flatMap(({ start, end, entries }) =>
    entries.some(
      ({ moduleRequest, importName }) =>
        moduleRequest !== null &&
        isService(file, moduleRequest.value) &&
        (!byName.has(importName.kind) || guarded.has(importName.name ?? ""))
    )
      ? [statementAt(source, start, end)]
      : []
  );
  const dynamic = module.dynamicImports.flatMap(
    ({ start, end, moduleRequest }) => {
      const specifier = literalValue(
        source.slice(moduleRequest.start, moduleRequest.end)
      );
      return specifier !== undefined && isService(file, specifier)
        ? [statementAt(source, start, end)]
        : [];
    }
  );
  return [...imports, ...exports, ...dynamic];
};

/** Every TypeScript source of core, relative to its `src`. */
const sources = async (): Promise<string[]> => {
  const entries = await readdir(core, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .map((entry) => entry.split(path.sep).join("/"));
};

describe("who answers a person's decision", () => {
  it("is reached from the person's session and the pages' bridge only", async () => {
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
      namespaceReexported: reachesOf(
        "agents/agent.ts",
        `export * as decisions from ${from};`
      ),
      mixed: reachesOf(
        "agents/agent.ts",
        `import { stillOpen, type answerDecision as A } from ${from};`
      ),
      unextended: reachesOf(
        "agents/agent.ts",
        'import { answerDecision } from "../decisions/decisions";'
      ),
      dynamic: reachesOf("agents/agent.ts", `const d = await import(${from});`),
      other: reachesOf("agents/agent.ts", `import { stillOpen } from ${from};`),
    }).toStrictEqual({
      named: [`import { answerDecision } from ${from}`],
      renamed: [`import { confirmDecision as mint, } from ${from}`],
      namespace: [`import * as decisions from ${from}`],
      reexported: [`export { answerDecision } from ${from}`],
      everything: [`export * from ${from}`],
      namespaceReexported: [`export * as decisions from ${from}`],
      mixed: [`import { stillOpen, type answerDecision as A } from ${from}`],
      unextended: ['import { answerDecision } from "../decisions/decisions"'],
      dynamic: [`import(${from})`],
      other: [],
    });
  });
});
