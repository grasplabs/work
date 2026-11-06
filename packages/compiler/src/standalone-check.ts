/**
 * A standalone definition project's type check (`npm run typecheck`), as
 * scripts/package-definition-lib.ts writes it to `grasp/check.ts`, beside
 * `grasp/steering.ts`: this file and steering.ts, as they are. It checks
 * the App the way the platform does, so code that builds here builds on
 * Grasp, and code Grasp refuses fails here.
 *
 * Each kind of code is checked on its own, with its own tsconfig, as the
 * root tsconfig.json lists them: the compiler's own options for it
 * (type-check.ts), with the checker the platform runs, tsrs
 * (`@tsrs/wasm`, the Rust port of TypeScript 7's), over the files as the
 * platform lays them out: the kind's App files, and the project's
 * packages where no App file's own lookup reaches them, each module its
 * kind may import mapped by name. Like the platform, it reports only the
 * App's own files, never the packages they import, and holds them to what
 * the platform does besides the options:
 *
 * - every App file parses as the platform's compile parses it, with
 *   Babel, which reads its comments and ambient declarations for the two
 *   rules below through the platform's own steering.ts;
 * - code whose types are checked (server code, compute
 *   modules) steers nothing: no triple-slash directive, no suppression
 *   (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`), no `declare
 *   global` or `declare module` (imports.ts, `typeChecked`);
 * - no App file holds a triple-slash directive but a reference path to
 *   one of the App's files (steering.ts `referenceError`);
 * - an App file resolves by name only the modules its kind may import
 *   (`TypeTarget.allowed`, which each tsconfig's `grasp.allowed` lists).
 *
 * Run with Node, which strips its types: `node grasp/check.ts`. It checks
 * in a worker thread of its own, with the deep stack tsrs's checker needs.
 */
import type { Dirent } from "node:fs";
import {
  globSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

import { parse } from "@babel/parser";
import {
  EXIT_CRASHED,
  makeRequest,
  NotFoundError,
  parseReply,
  runTsc,
} from "@tsrs/wasm/core";
import type { Diagnostic, FileStat, HostFileSystem } from "@tsrs/wasm/core";

import {
  ambientOf,
  directivesIn,
  parserPlugins,
  referenceError,
} from "./steering.ts";
import type { ModuleDeclaration } from "./steering.ts";

/** A problem in an App file, or in a check's options. */
interface Problem {
  readonly file: string | undefined;
  readonly line: number | undefined;
  readonly column: number | undefined;
  readonly code: string;
  readonly message: string;
}

/** What the platform holds a kind of code to besides its options. */
interface Kind {
  /** Whether it reports `file` (relative to its tsconfig's directory). */
  readonly reports: (file: string) => boolean;
  /**
   * Whether no comment in `file` may steer the check: no triple-slash
   * directive beyond a reference path, no suppression.
   */
  readonly steered: (file: string) => boolean;
  /** Whether `file` may declare ambient modules or globals: the host's own code. */
  readonly declares: (file: string) => boolean;
  /** Whether `file`'s own type errors aren't yet the platform's. */
  readonly lenient: (file: string) => boolean;
}

const every = (): boolean => true;
const none = (): boolean => false;
const generated = (file: string): boolean => file.startsWith(".grasp/");

/**
 * The pages' route tree, which the host generates (route-tree.ts): it
 * registers their router with `@tanstack/react-router`, as its own
 * module declarations do (inputs.ts `routeTreePath`).
 */
const routeTree = (file: string): boolean => file === "src/routeTree.gen.ts";

/**
 * The kinds of code, as each tsconfig's `grasp.kind` names it. Server
 * code's migrations are checked for what they name, not yet for their
 * own type errors (compiler `checkAppCode`, GRA-690); and the host's
 * generated modules are its own.
 */
const kinds: Readonly<Record<string, Kind>> = {
  pages: { reports: every, steered: none, declares: routeTree, lenient: none },
  server: {
    reports: every,
    steered: (file) => !generated(file),
    declares: generated,
    lenient: (file) => file.startsWith("server/migrations/"),
  },
  compute: { reports: every, steered: every, declares: none, lenient: none },
  generated: { reports: every, steered: none, declares: every, lenient: none },
};

/** `value`'s own `key`, when `value` is an object (parsed JSON). */
const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((each) => typeof each === "string")
    ? value
    : undefined;

/** A tsconfig's `grasp`: its kind of code, and what it may import. */
const graspOf = (
  value: unknown
): { kind: Kind; allowed: readonly string[] | undefined } | undefined => {
  const kind = fieldOf(value, "kind");
  const allowed = fieldOf(value, "allowed");
  const known =
    typeof kind === "string" && Object.hasOwn(kinds, kind)
      ? kinds[kind]
      : undefined;
  if (known === undefined) {
    return undefined;
  }
  if (allowed === undefined) {
    return { kind: known, allowed: undefined };
  }
  const names = strings(allowed);
  return names === undefined ? undefined : { kind: known, allowed: names };
};

const root = path.dirname(import.meta.dirname);

/** `file` as a path from `dir`, `/`-separated. */
const relativeTo = (dir: string, file: string): string =>
  path.relative(dir, file).split(path.sep).join("/");

/** Where a check's project packages are, for a kind that resolves any of them. */
const kitRoot = "/node_modules/";

/**
 * Where they are for a kind that resolves only some: out of reach of
 * every App file's own lookup, as the platform lays them out
 * (type-check.ts `hiddenKitRoot`).
 */
const hiddenKitRoot = "/.kit/node_modules/";

/** An App file a check reads: TypeScript, declarations included. */
const checkedFile = /\.tsx?$/u;

/**
 * The files a check reads, by their path in it: the kind's App files at
 * `/<path>` (from its tsconfig's directory), files the check writes, and
 * the project's packages under `kit`, read from `node_modules`. Nothing
 * else of the project is there: a file beside the App's that the kind
 * leaves out doesn't exist on the platform either.
 */
interface Layout {
  readonly app: ReadonlyMap<string, string>;
  readonly written: ReadonlyMap<string, string>;
  readonly kit: string;
}

const directoryStat: FileStat = { kind: "d", size: 0, mtimeNs: 0n };

/** A path the check's layout doesn't hold, as tsrs takes one. */
const missing = (file: string): never => {
  throw new NotFoundError(file);
};

/** A directory entry's kind, as tsrs reads it: a link is followed by a stat. */
const entryKind = (entry: Dirent): "l" | "d" | "f" => {
  if (entry.isSymbolicLink()) {
    return "l";
  }
  return entry.isDirectory() ? "d" : "f";
};

/** What the check's `layout` holds, as tsrs reads files: from disk, only where the layout has them. */
const layoutFileSystem = (layout: Layout): HostFileSystem => {
  const packages = path.join(root, "node_modules");
  const own = [...layout.app.keys(), ...layout.written.keys()];
  /** Every directory that holds a file of the App's, or the check's own, and the kit's way down. */
  const directories = new Set(["/"]);
  for (const file of [...own, layout.kit]) {
    for (
      let end = file.lastIndexOf("/");
      end > 0;
      end = file.lastIndexOf("/", end - 1)
    ) {
      directories.add(file.slice(0, end));
    }
  }
  const onDisk = (file: string): string | undefined => {
    if (file.startsWith(layout.kit)) {
      return path.join(packages, file.slice(layout.kit.length));
    }
    return layout.app.get(file);
  };
  return {
    readFile: (file) => {
      const text = layout.written.get(file);
      if (text !== undefined) {
        return new TextEncoder().encode(text);
      }
      const real = onDisk(file) ?? missing(file);
      try {
        return readFileSync(real);
      } catch {
        return missing(file);
      }
    },
    stat: (file) => {
      const text = layout.written.get(file);
      if (text !== undefined) {
        return { kind: "f", size: text.length, mtimeNs: 0n };
      }
      if (directories.has(file.replace(/\/+$/u, "") || "/")) {
        return directoryStat;
      }
      const real = onDisk(file) ?? missing(file);
      try {
        const found = statSync(real, { bigint: true });
        return {
          kind: found.isDirectory() ? "d" : "f",
          size: found.size,
          mtimeNs: found.mtimeNs,
        };
      } catch {
        return missing(file);
      }
    },
    readDir: (dir) => {
      const at = dir.replace(/\/+$/u, "") || "/";
      if (`${at}/`.startsWith(layout.kit)) {
        const real = onDisk(`${at}/`) ?? missing(dir);
        try {
          return readdirSync(real, { withFileTypes: true }).map((entry) => [
            entryKind(entry),
            entry.name,
          ]);
        } catch {
          return missing(dir);
        }
      }
      const prefix = at === "/" ? "/" : `${at}/`;
      const entries = new Map<string, "f" | "d">();
      for (const file of [...own, layout.kit]) {
        if (file.startsWith(prefix)) {
          const [name = "", ...rest] = file.slice(prefix.length).split("/");
          if (name !== "") {
            entries.set(name, rest.length > 0 ? "d" : "f");
          }
        }
      }
      return [...entries].map(([name, kind]) => [kind, name]);
    },
    realpath: (file) => file,
    writeFile: () => {
      // Nothing is emitted.
    },
    remove: () => {
      // Nothing is emitted.
    },
    chtimes: () => {
      // Nothing is emitted.
    },
  };
};

/** One run of tsc over `layout`: its exit, its diagnostics, and what it said. */
const runOver = (
  tsrs: WebAssembly.Module,
  layout: Layout,
  args: readonly string[]
): {
  exitCode: number;
  diagnostics: Diagnostic[];
  stdout: string;
  stderr: string;
} => {
  const decoder = new TextDecoder();
  let stdout = "";
  let stderr = "";
  const { exitCode, reply } = runTsc(
    tsrs,
    makeRequest(["-p", "/tsconfig.json", ...args], { cwd: "/", json: true }),
    layoutFileSystem(layout),
    {
      env: {},
      stdout: (chunk) => {
        stdout += decoder.decode(chunk, { stream: true });
      },
      stderr: (chunk) => {
        stderr += decoder.decode(chunk, { stream: true });
      },
    }
  );
  let diagnostics: Diagnostic[] = [];
  try {
    diagnostics = parseReply(reply);
  } catch {
    // Unreadable: no diagnostics, so a failure below says it ran wrong.
  }
  return { exitCode, diagnostics, stdout, stderr };
};

/** What tsc's trace says a module name resolved to: `======== Module name 'x' was successfully resolved to '/y'. ========`. */
const resolvedTrace =
  /^======== Module name '(?<name>[^']+)' was successfully resolved to '(?<file>[^']+)'/u;

/**
 * Where each of `allowed` resolves among the project's packages, as tsc
 * resolves it from an App file and reports it in its trace: what the
 * check maps them to (`paths`) once the packages are out of the App's
 * reach, as the platform's are (type-check.ts `KitTypes.resolved`). Only
 * `allowed` itself: the trace also holds what those packages import
 * (`zod`, from the SDK), which they reach by their own lookup and an App
 * file never does.
 */
const resolvedNames = (
  tsrs: WebAssembly.Module,
  options: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): Map<string, string> => {
  const probe = "/probe.ts";
  const { stdout } = runOver(
    tsrs,
    {
      app: new Map(),
      written: new Map([
        [
          probe,
          allowed
            .map((name) => `import type * as _ from ${JSON.stringify(name)};`)
            .join("\n"),
        ],
        [
          "/tsconfig.json",
          JSON.stringify({
            compilerOptions: { ...options, paths: {}, noEmit: true },
            files: [`.${probe}`],
          }),
        ],
      ]),
      kit: kitRoot,
    },
    ["--traceResolution"]
  );
  const names = new Set(allowed);
  const resolved = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const groups = resolvedTrace.exec(line)?.groups;
    if (
      groups?.name !== undefined &&
      names.has(groups.name) &&
      groups.file?.startsWith(kitRoot) === true
    ) {
      resolved.set(groups.name, groups.file);
    }
  }
  return resolved;
};

/** 1-based line and column of `position` in `text`. */
const lineAndColumn = (
  text: string,
  position: number
): { line: number; column: number } => {
  const before = text.slice(0, position).split(/\r\n?|[\n\u2028\u2029]/u);
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
};

const problemAt = (
  file: string,
  text: string,
  position: number,
  code: string,
  message: string
): Problem => ({ file, ...lineAndColumn(text, position), code, message });

/** A 1-based line and column. */
interface Where {
  readonly line: number | undefined;
  readonly column: number | undefined;
}

/** Where Babel puts a node or an error (`loc`, 0-based column), 1-based. */
const whereOf = (position: unknown): Where => {
  const line = fieldOf(position, "line");
  const column = fieldOf(position, "column");
  return {
    line: typeof line === "number" ? line : undefined,
    column: typeof column === "number" ? column + 1 : undefined,
  };
};

/** An App file as Babel parses it: its comments and syntax tree. */
interface Parsed {
  readonly comments: Parameters<typeof directivesIn>[0];
  readonly program: unknown;
}

/**
 * `text` parsed as the platform's compile parses `file`, with the same
 * parser options (steering.ts `parserPlugins`), or the parser's refusal
 * of it, which the platform's build reports.
 */
const parsedOf = (file: string, text: string): Parsed | Problem => {
  try {
    const { comments, program } = parse(text, {
      sourceType: "module",
      plugins: parserPlugins(file),
    });
    return { comments: comments ?? [], program };
  } catch (error) {
    return {
      file,
      ...whereOf(fieldOf(error, "loc")),
      code: "compile",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

/** Every `declare module` or `declare global` in a syntax tree, with its line. */
const ambientDeclarations = (
  program: unknown
): (ModuleDeclaration & Where)[] => {
  const found: (ModuleDeclaration & Where)[] = [];
  const pending: unknown[] = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null) {
      continue;
    }
    if (fieldOf(node, "type") === "TSModuleDeclaration") {
      const id = fieldOf(node, "id");
      const type = fieldOf(id, "type");
      const value = fieldOf(id, "value");
      const name = fieldOf(id, "name");
      found.push({
        id: {
          type: typeof type === "string" ? type : "",
          value,
          name: typeof name === "string" ? name : undefined,
        },
        global: fieldOf(node, "global") === true,
        ...whereOf(fieldOf(fieldOf(node, "loc"), "start")),
      });
    }
    const children: unknown[] = Object.values(node);
    pending.push(...children);
  }
  return found;
};

/** The comments in a parsed file TypeScript obeys as directives to its check. */
const directiveProblems = (file: string, { comments }: Parsed): Problem[] =>
  directivesIn(comments).map(({ directive, line, column }) => ({
    file,
    line,
    column,
    code: "steering",
    message: `${directive} is never in this code: its type check is the platform's, as it is.`,
  }));

/**
 * The ambient module and global declarations in a parsed file, which
 * would declare, or shadow, a module by name, or give every file globals
 * (steering.ts `ambientOf`, as the platform reads them).
 */
const ambientProblems = (file: string, { program }: Parsed): Problem[] =>
  ambientDeclarations(program).flatMap(({ line, column, ...declaration }) => {
    const ambient = ambientOf(declaration);
    if (ambient === undefined) {
      return [];
    }
    return [
      {
        file,
        line,
        column,
        code: "steering",
        message:
          "module" in ambient
            ? `declare module ${JSON.stringify(ambient.module)} is never in App code: it would declare, or shadow, a module the platform doesn't give it.`
            : "declare global is never in App code: it would declare globals its runtime doesn't have, for every file.",
      },
    ];
  });

/**
 * What `inCheck`'s triple-slash directives, wherever in the file, reach
 * beyond the App's files (`app`, by their path from the App's root): only
 * a reference path to one of them, nothing else (steering.ts
 * `referenceError`).
 */
const referencesIn = (
  file: string,
  inCheck: string,
  { comments }: Parsed,
  app: ReadonlySet<string>
): Problem[] =>
  directivesIn(comments).flatMap(({ directive, line, column }) => {
    const message = referenceError(directive, inCheck, app);
    return message === undefined
      ? []
      : [{ file, line, column, code: "imports", message }];
  });

/** A diagnostic's message and its chain, as TypeScript flattens them, one level of indent each. */
const flattened = (diagnostic: Diagnostic, indent = 0): string =>
  [
    indent === 0 ? "" : `\n${"  ".repeat(indent)}`,
    diagnostic.text,
    ...(diagnostic.messageChain ?? []).map((next) =>
      flattened(next, indent + 1)
    ),
  ].join("");

/** The files a tsconfig's `include` and `exclude` name, from `dir`, outside `node_modules`. */
const filesOf = (dir: string, config: unknown): string[] => {
  const excluded = new Set(
    globSync(strings(fieldOf(config, "exclude")) ?? [], { cwd: dir })
  );
  return globSync(strings(fieldOf(config, "include")) ?? [], { cwd: dir })
    .filter((file) => checkedFile.test(file) && !excluded.has(file))
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => !file.split("/").includes("node_modules"))
    .toSorted();
};

/** A tsconfig finding no files: a kind the App has none of. */
const configProblem = (config: string): Problem[] => [
  {
    file: config,
    line: undefined,
    column: undefined,
    code: "config",
    message: "This isn't a tsconfig the project's check reads.",
  },
];

/**
 * What the platform's build refuses in a kind's files (`texts`, by their
 * path from the App's root) before any type check: a file its parser
 * can't read, or code that steers the check, which so never reaches it
 * (a `/// <reference lib="dom" />` in one file can't give every other
 * file the DOM here either); and the triple-slash directives it refuses
 * beside the check's own errors. Each only for the files the kind
 * reports, so a file two kinds read is refused once, by its own kind.
 */
const readFiles = (
  texts: ReadonlyMap<string, string>,
  kind: Kind,
  shown: (file: string) => string
): { refused: Problem[]; references: Problem[] } => {
  const files = new Set(texts.keys());
  const refused: Problem[] = [];
  const references: Problem[] = [];
  for (const [file, text] of texts) {
    if (!kind.reports(file)) {
      continue;
    }
    const parsed = parsedOf(shown(file), text);
    if (!("program" in parsed)) {
      refused.push(parsed);
      continue;
    }
    if (kind.steered(file)) {
      refused.push(...directiveProblems(shown(file), parsed));
    }
    if (!kind.declares(file)) {
      refused.push(...ambientProblems(shown(file), parsed));
    }
    references.push(...referencesIn(shown(file), file, parsed, files));
  }
  return { refused, references };
};

/** Checks one kind of code by its tsconfig, `config` from the root. */
const checkKind = (tsrs: WebAssembly.Module, config: string): Problem[] => {
  const configPath = path.resolve(root, config);
  const dir = path.dirname(configPath);
  let read: unknown;
  try {
    read = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return configProblem(config);
  }
  const grasp = graspOf(fieldOf(read, "grasp"));
  const given = fieldOf(read, "compilerOptions");
  if (grasp === undefined || typeof given !== "object" || given === null) {
    return configProblem(config);
  }
  const options: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(given)
  );
  const files = filesOf(dir, read);
  if (files.length === 0) {
    return [];
  }
  const { kind, allowed } = grasp;
  const shown = (file: string): string =>
    relativeTo(root, path.join(dir, file));
  const texts = new Map(
    files.map((file) => [file, readFileSync(path.join(dir, file), "utf-8")])
  );
  const { refused, references } = readFiles(texts, kind, shown);
  if (refused.length > 0) {
    return refused;
  }
  const app = new Map(files.map((file) => [`/${file}`, path.join(dir, file)]));
  const kit = allowed === undefined ? kitRoot : hiddenKitRoot;
  const paths: Record<string, unknown> = {};
  if (allowed !== undefined) {
    for (const [name, file] of resolvedNames(tsrs, options, allowed)) {
      paths[name] = [`.${hiddenKitRoot}${file.slice(kitRoot.length)}`];
    }
  }
  Object.assign(paths, fieldOf(options, "paths") ?? {});
  const { exitCode, diagnostics, stderr } = runOver(
    tsrs,
    {
      app,
      written: new Map([
        [
          "/tsconfig.json",
          JSON.stringify({
            compilerOptions: {
              ...options,
              paths,
              skipLibCheck: !files.some((file) => file.endsWith(".d.ts")),
            },
            files: files.map((file) => `./${file}`),
          }),
        ],
      ]),
      kit,
    },
    []
  );
  const said = stderr.trim().split("\n")[0] ?? "";
  if (
    exitCode === EXIT_CRASHED ||
    exitCode > 2 ||
    (exitCode !== 0 && !diagnostics.some(({ category }) => category === 1))
  ) {
    return [
      {
        file: config,
        line: undefined,
        column: undefined,
        code: "check",
        message: `The type check couldn't run (tsc exited with ${exitCode})${said === "" ? "" : `: ${said}`}.`,
      },
    ];
  }
  const found = diagnostics.flatMap((diagnostic): Problem[] => {
    const { fileName } = diagnostic;
    if (diagnostic.category !== 1 || fileName?.startsWith(kit) === true) {
      return [];
    }
    const message = flattened(diagnostic).replaceAll(kit, kitRoot);
    const code = `TS${diagnostic.code}`;
    const file = fileName === undefined ? undefined : fileName.slice(1);
    if (file === undefined || !texts.has(file)) {
      return [
        { file: config, line: undefined, column: undefined, code, message },
      ];
    }
    if (!kind.reports(file) || kind.lenient(file)) {
      return [];
    }
    return [
      diagnostic.startPosition === undefined
        ? problemAt(
            shown(file),
            texts.get(file) ?? "",
            diagnostic.pos,
            code,
            message
          )
        : {
            file: shown(file),
            line: diagnostic.startPosition.line + 1,
            column: diagnostic.startPosition.character + 1,
            code,
            message,
          },
    ];
  });
  return [...found, ...references];
};

/** The tsconfigs the root tsconfig.json lists, one a kind of code. */
const configs = (): string[] => {
  const read: unknown = JSON.parse(
    readFileSync(path.join(root, "tsconfig.json"), "utf-8")
  );
  const references = fieldOf(read, "references");
  if (!Array.isArray(references)) {
    throw new TypeError("tsconfig.json lists no tsconfigs to check.");
  }
  return references.map((reference: unknown) => {
    const configPath = fieldOf(reference, "path");
    if (typeof configPath !== "string") {
      throw new TypeError("tsconfig.json lists a tsconfig without its path.");
    }
    return configPath;
  });
};

/** Every kind's problems, printed as tsc prints them. */
const checkAll = (): void => {
  // Made as Node makes a module; the Workers types the platform's code is
  // checked with type the class as one only the runtime makes.
  const tsrs: unknown = Reflect.construct(WebAssembly.Module, [
    readFileSync(
      realpathSync(path.join(root, "node_modules/@tsrs/wasm/tsrs.wasm"))
    ),
  ]);
  if (!(tsrs instanceof WebAssembly.Module)) {
    throw new TypeError("tsrs's WebAssembly didn't compile.");
  }
  const problems = configs().flatMap((config) => checkKind(tsrs, config));
  for (const { file, line, column, code, message } of problems) {
    const where =
      file === undefined
        ? ""
        : `${relativeTo(root, path.resolve(root, file))}${line === undefined ? "" : `(${line},${column})`}: `;
    process.stderr.write(`${where}error ${code}: ${message}\n`);
  }
  // A worker thread's port, not a window's: it takes no origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- see above
  parentPort?.postMessage(problems.length > 0 ? 1 : 0);
};

if (isMainThread) {
  // The checker recurses deeply, and each WebAssembly frame takes the
  // engine's own stack: a worker gets one as deep as tsrs's own runs do.
  const worker = new Worker(import.meta.filename, {
    resourceLimits: { stackSizeMb: 256 },
  });
  worker.on("message", (code: unknown) => {
    process.exitCode = typeof code === "number" ? code : 1;
  });
  worker.on("error", (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
} else {
  checkAll();
}
