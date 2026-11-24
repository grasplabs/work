import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseSync, Visitor } from "oxc-parser";
import { describe, expect, it } from "vite-plus/test";

// Agents never answer a person's decision (GRA-624, threat model T7): the
// decision service's answer and confirmation are reached only through a
// person's session, `decisions` (decisions/rpc.ts) and the pages'
// bridge (workflows/page-decisions.ts), which pages-rpc.ts alone reaches.
// Agents act through an `Authority`, never a session; a new import of
// these anywhere else in core could hand one a way in. This guard fails on
// any such import, a re-export, or a namespace or dynamic import of the
// modules that would reach them, and on any import it can't resolve: a
// dynamic import of anything but a plain string, or `import.meta.glob`.

const core = path.join(import.meta.dirname, "../apps/core/src");

/** What core may reach of a guarded module, and from where. */
interface Guard {
  /** The module, within core's sources. */
  module: string;
  /** Its guarded exports: an import of any other name of it passes. Every export, without. */
  names?: ReadonlySet<string>;
  /** The only sources that may reach them. */
  allowed: ReadonlySet<string>;
}

const guards: readonly Guard[] = [
  {
    // The functions that record or confirm a person's answer: the
    // person's session, and the pages' bridge, which answers for the
    // person with the page open (`appFor`).
    module: "decisions/decisions.ts",
    names: new Set(["answerDecision", "confirmDecision"]),
    allowed: new Set(["decisions/rpc.ts", "workflows/page-decisions.ts"]),
  },
  {
    // The pages' bridge itself, called from a page's own session alone.
    module: "workflows/page-decisions.ts",
    allowed: new Set(["pages-rpc.ts"]),
  },
];

/** What a source reaches that no guard can tell apart: never allowed. */
const unresolved = "an import it can't resolve";

/** The sources core is built from, by their extension. */
const sourceFile = /\.[cm]?[jt]sx?$/u;

/** A JavaScript extension a TypeScript import is written with, for the `.ts` it resolves to. */
const javaScriptExtension = /\.m?js$/u;

/** The module `specifier`, imported from `file`, resolves to within core's sources, if it is one of its own. */
const resolvedOf = (file: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const resolved = path.posix
    .join(path.posix.dirname(file), specifier)
    .replace(javaScriptExtension, ".ts");
  return /\.(?:ts|tsx|mts)$/u.test(resolved) ? resolved : `${resolved}.ts`;
};

/** The one kind of import or re-export that takes names one by one: any other takes the module whole. */
const byName: ReadonlySet<string> = new Set(["Name"]);

/** A statement's text, as one line, without its semicolon. */
const statementAt = (source: string, start: number, end: number): string =>
  source.slice(start, end).replaceAll(/\s+/gu, " ").replace(/;$/u, "");

/** A plain string literal's value: undefined for any other expression, a template with a placeholder among them. */
const literalValue = (written: string): string | undefined => {
  const value = /^(?<quote>["'`])(?<value>[^"'`]*)\k<quote>$/u.exec(
    written.trim()
  )?.groups?.value;
  return value?.includes("${") === true ? undefined : value;
};

/** Each guarded module reached, by it, with the statement that reaches it. */
type Reach = [module: string, statement: string];

/** The guard of the module `specifier` resolves to from `file`, if it is guarded. */
const guardOf = (file: string, specifier: string): Guard | undefined => {
  const resolved = resolvedOf(file, specifier);
  return guards.find(({ module }) => module === resolved);
};

/** Whether an import of `kind` and `name` takes something `guard` guards. */
const takes = (guard: Guard, kind: string, name: string | null): boolean =>
  guard.names === undefined || !byName.has(kind) || guard.names.has(name ?? "");

/**
 * What `source`, at `file` within core's sources, reaches of the guarded
 * modules, as oxc parses its module: each import, re-export or namespace
 * or dynamic import that could, type-only ones too, as written; and each
 * import it can't resolve. None of a guarded module from itself.
 */
const reachesOf = (file: string, source: string): Reach[] => {
  const { program, module, errors } = parseSync(file, source);
  if (errors.length > 0) {
    throw new Error(`${file} doesn't parse: ${errors[0]?.message ?? ""}`);
  }
  const imports = module.staticImports.flatMap(
    ({ start, end, moduleRequest, entries }): Reach[] => {
      const guard = guardOf(file, moduleRequest.value);
      return guard !== undefined &&
        guard.module !== file &&
        entries.some(({ importName }) =>
          takes(guard, importName.kind, importName.name)
        )
        ? [[guard.module, statementAt(source, start, end)]]
        : [];
    }
  );
  const exports = module.staticExports.flatMap(
    ({ start, end, entries }): Reach[] => {
      // An export of an imported name is one of its module's, as the
      // standard reads it: its entry names that module.
      const reached = entries.flatMap(({ moduleRequest, importName }) => {
        const guard =
          moduleRequest === null
            ? undefined
            : guardOf(file, moduleRequest.value);
        return guard !== undefined &&
          guard.module !== file &&
          takes(guard, importName.kind, importName.name)
          ? [guard.module]
          : [];
      });
      return [...new Set(reached)].map((each): Reach => [
        each,
        statementAt(source, start, end),
      ]);
    }
  );
  const dynamic = module.dynamicImports.flatMap(
    ({ start, end, moduleRequest }): Reach[] => {
      const specifier = literalValue(
        source.slice(moduleRequest.start, moduleRequest.end)
      );
      if (specifier === undefined) {
        return [[unresolved, statementAt(source, start, end)]];
      }
      const guard = guardOf(file, specifier);
      return guard === undefined || guard.module === file
        ? []
        : [[guard.module, statementAt(source, start, end)]];
    }
  );
  // Any part of `import.meta` but its address and environment may load
  // modules: `glob` and its kin, however written.
  const globs = module.importMetas.flatMap(({ start, end }): Reach[] =>
    /^\s*\.\s*(?:url|env)\b/u.test(source.slice(end))
      ? []
      : [[unresolved, statementAt(source, start, end + 5)]]
  );
  // CommonJS: a `require` a bundler would follow, which oxc lists among no
  // imports.
  const required: Reach[] = [];
  new Visitor({
    CallExpression: (node) => {
      if (node.callee.type === "Identifier" && node.callee.name === "require") {
        required.push([unresolved, statementAt(source, node.start, node.end)]);
      }
    },
  }).visit(program);
  return [...imports, ...exports, ...dynamic, ...globs, ...required];
};

/** Every source of core, relative to its `src`. */
const sources = async (): Promise<string[]> => {
  const entries = await readdir(core, { recursive: true });
  return entries
    .filter((entry) => sourceFile.test(entry))
    .map((entry) => entry.split(path.sep).join("/"));
};

/** The reaches of `found` that no guard allows from `file`. */
const disallowed = (file: string, found: Reach[]): Reach[] =>
  found.filter(
    ([module]) =>
      guards.find((guard) => guard.module === module)?.allowed.has(file) !==
      true
  );

describe("who answers a person's decision", () => {
  it("is reached from the person's session and the pages' bridge only, which the pages' session alone reaches", async () => {
    const reached: Record<string, Reach[]> = {};
    for (const file of await sources()) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time
      const source = await readFile(path.join(core, file), "utf-8");
      const found = reachesOf(file, source);
      if (found.length > 0) {
        reached[file] = found;
      }
    }

    expect(
      Object.entries(reached).flatMap(([file, found]) =>
        disallowed(file, found).map(
          ([module, statement]) => `${file}: ${module}: ${statement}`
        )
      )
    ).toStrictEqual([]);
    expect(Object.keys(reached).toSorted()).toStrictEqual(
      [...new Set(guards.flatMap(({ allowed }) => [...allowed]))].toSorted()
    );
  });

  it("catches each way of importing them", () => {
    const from = '"../decisions/decisions.ts"';
    const service = "decisions/decisions.ts";
    const bridge = "workflows/page-decisions.ts";
    // A template with a placeholder, as written in a source.
    const computed = `\`../decisions/\${name}.ts\``;
    const of = (source: string): Reach[] =>
      reachesOf("agents/agent.ts", source);

    expect({
      named: of(`import { answerDecision } from ${from};`),
      renamed: of(`import {\n  confirmDecision as mint,\n} from ${from};`),
      namespace: of(`import * as decisions from ${from};`),
      reexported: of(`export { answerDecision } from ${from};`),
      everything: of(`export * from ${from};`),
      namespaceReexported: of(`export * as decisions from ${from};`),
      mixed: of(`import { stillOpen, type answerDecision as A } from ${from};`),
      unextended: of(
        'import { answerDecision } from "../decisions/decisions";'
      ),
      javaScript: of(
        'import { answerDecision } from "../decisions/decisions.js";'
      ),
      dynamic: of(`const d = await import(${from});`),
      computed: of(`const d = await import(${computed});`),
      variable: of("const d = await import(where);"),
      glob: of('const all = import.meta.glob("../decisions/*.ts");'),
      bridgeNamed: of(
        'import { appDecision } from "../workflows/page-decisions.ts";'
      ),
      other: of(`import { stillOpen } from ${from};`),
      meta: of("const here = import.meta.url;"),
      passedOn: of(
        `import { answerDecision as answer } from ${from};\nexport { answer };`
      ),
      required: of('const d = require("../decisions/decisions.ts");'),
    }).toStrictEqual({
      named: [[service, `import { answerDecision } from ${from}`]],
      renamed: [[service, `import { confirmDecision as mint, } from ${from}`]],
      namespace: [[service, `import * as decisions from ${from}`]],
      reexported: [[service, `export { answerDecision } from ${from}`]],
      everything: [[service, `export * from ${from}`]],
      namespaceReexported: [[service, `export * as decisions from ${from}`]],
      mixed: [
        [
          service,
          `import { stillOpen, type answerDecision as A } from ${from}`,
        ],
      ],
      unextended: [
        [service, 'import { answerDecision } from "../decisions/decisions"'],
      ],
      javaScript: [
        [service, 'import { answerDecision } from "../decisions/decisions.js"'],
      ],
      dynamic: [[service, `import(${from})`]],
      computed: [[unresolved, `import(${computed})`]],
      variable: [[unresolved, "import(where)"]],
      glob: [[unresolved, "import.meta.glob"]],
      bridgeNamed: [
        [
          bridge,
          'import { appDecision } from "../workflows/page-decisions.ts"',
        ],
      ],
      other: [],
      meta: [],
      passedOn: [
        [service, `import { answerDecision as answer } from ${from}`],
        // oxc gives the export the import's place, where the name comes from.
        [service, `import { answerDecision as answer } from ${from}`],
      ],
      required: [[unresolved, 'require("../decisions/decisions.ts")']],
    });
    // Allowed only where each guard allows it: the bridge from its
    // session, the service from the bridge.
    expect({
      bridgeFromPages: disallowed("pages-rpc.ts", [
        [bridge, "import { appDecision } from ./workflows/page-decisions.ts"],
      ]),
      serviceFromPages: disallowed("pages-rpc.ts", [
        [service, "import { answerDecision } from ./decisions/decisions.ts"],
      ]),
      unresolvedAnywhere: disallowed("decisions/rpc.ts", [
        [unresolved, "import(where)"],
      ]),
    }).toStrictEqual({
      bridgeFromPages: [],
      serviceFromPages: [
        [service, "import { answerDecision } from ./decisions/decisions.ts"],
      ],
      unresolvedAnywhere: [[unresolved, "import(where)"]],
    });
  });
});
