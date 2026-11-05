/**
 * Type-checks App files with tsrs (`@tsrs/wasm`), the Rust port of
 * TypeScript 7's checker, run as `tsc` over files in memory: the App's
 * files at `/<path>`, the kit's type chunks and the libraries they name
 * (`KitTypes`, build.ts) under `/node_modules`, and a tsconfig with the
 * target's options. Each check is a fresh instance of the module that
 * keeps nothing: it runs in an isolate of its own (checker.ts).
 */
import {
  EXIT_CRASHED,
  makeRequest,
  memoryFileSystem,
  parseReply,
  runTsc,
} from "@tsrs/wasm/core";
import type { Diagnostic as TscDiagnostic } from "@tsrs/wasm/core";

import { generatedModules, serverSdkImports } from "./app-code.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { computeSdkImports, sdkImports } from "./imports.ts";
import { screenReferences } from "./kit.ts";

/** A tsconfig's `compilerOptions`, as JSON. */
export type CompilerOptions = Readonly<Record<string, unknown>>;

/**
 * How App code is checked, as a tsconfig writes it. `build.ts` loads the
 * kit with the same options to collect the files a check reads, so both
 * must agree.
 */
export const compilerOptions = {
  target: "es2022",
  // `Symbol.dispose`: Cap'n Web's callbacks and stubs, which screens pass
  // to and get from their server, are disposable.
  lib: ["es2024", "dom", "esnext.disposable"],
  module: "esnext",
  moduleResolution: "bundler",
  jsx: "react-jsx",
  strict: true,
  // No `noUnusedLocals`: an unused name is the lint's (`no-unused-vars`,
  // ultracite-rules.ts and ultracite-plugins.ts), which keeps a draft from
  // being proposed. As a type error, one unused import mid-edit would stop
  // the build and the preview.
  // Babel compiles each file on its own.
  isolatedModules: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  // Off, so the App's own declaration files are checked. Only App files'
  // diagnostics count, so the kit's declarations' don't (`typeCheck`).
  skipLibCheck: false,
  types: [],
  // The App's generated references, as its screens import them.
  paths: { [screenReferences.specifier]: [`./${screenReferences.path}`] },
} as const satisfies CompilerOptions;

/**
 * What a type check holds App files to: its options (the lib among them),
 * the bare names that map to App files, and the modules an App file may
 * resolve by name (`undefined`: any, for code the host generated alone).
 */
export interface TypeTarget {
  readonly options: CompilerOptions;
  readonly mapped: ReadonlySet<string>;
  readonly allowed?: ReadonlySet<string>;
}

/** Code the host generated, checked against its SDK as it imports it. */
export const generatedTarget: TypeTarget = {
  options: compilerOptions,
  mapped: new Set([screenReferences.specifier]),
};

/** A screen's files: the DOM's lib, the kit's modules (`allowed`). */
export const screenTarget = (allowed: ReadonlySet<string>): TypeTarget => ({
  options: compilerOptions,
  mapped: new Set([screenReferences.specifier]),
  allowed,
});

/**
 * The libs an App's server code is checked with besides the language's:
 * a worker's globals (`setTimeout`, `crypto`, `TextEncoder`, `URL`,
 * `console`, …), as its isolate has them, and no DOM: no `window`,
 * `document` or `localStorage`. The worker lib also types `fetch`, which
 * the isolate has but can't use: it runs without network, and a call
 * fails there.
 */
export const serverLibs = ["webworker"];

/**
 * An App's server code of spec 8's layout (app-code.ts): no DOM, which
 * its isolate doesn't have, no JSX; the generated modules by their
 * aliases; and by name only the SDK's modules it and its generated
 * modules import.
 */
export const serverTarget = (
  generated: Readonly<Record<string, string>>,
  allowed: ReadonlySet<string>
): TypeTarget => {
  const { jsx: _jsx, ...options } = compilerOptions;
  return {
    options: {
      ...options,
      // Every file is a module of its own, as the build loads it: a file
      // without imports or exports shares nothing with the others, though
      // TypeScript would otherwise read it as a script whose names they see.
      moduleDetection: "force",
      lib: ["es2024", ...serverLibs, "esnext.disposable"],
      paths: Object.fromEntries(
        Object.entries(generated).map(([alias, path]) => [alias, [`./${path}`]])
      ),
    },
    mapped: new Set(Object.keys(generated)),
    allowed,
  };
};

/**
 * How an App's server code is type-checked: the
 * generated modules by their aliases, and by name the SDK's modules it
 * and they import: its root, the server constructors, the database's
 * types the constructors name, and nothing else.
 */
export const appCodeTarget = serverTarget(
  generatedModules,
  new Set([
    ...serverSdkImports,
    "@grasp-os/sdk/database",
    // Its tests' (app-code.ts): what the source checks give tests alone.
    "@grasp-os/sdk/testing",
  ])
);

/**
 * How an App's workflows are type-checked: no DOM, which
 * their isolate doesn't have, no JSX, each file a module of its own; by
 * name only the SDK's workflow modules they may import, and those the
 * App's server code their types may name imports (`appCodeTarget`'s),
 * with its generated modules by their aliases. A workflow's values reach
 * none of the server's: its build holds them to `sdkImports`.
 */
export const workflowTarget = serverTarget(
  generatedModules,
  new Set([...sdkImports, ...serverSdkImports, "@grasp-os/sdk/database"])
);

/**
 * How a JSON workflow's compute modules are type-checked:
 * a worker's lib and no DOM, which their isolate doesn't have, no JSX,
 * each file a module of its own; and by name only the SDK's modules they
 * may import (`computeSdkImports`), with their own files. An approved
 * package entry resolves to no file, so to the ambient module the host
 * declares for it (`buildComputeModules`), never to anything of the kit.
 */
export const computeTarget = serverTarget({}, new Set(computeSdkImports));

/**
 * What the check reads of the kit (build.ts `typeChunks`): the type
 * chunks and the libraries they name, by path under `/node_modules`, and
 * where each module App code may import by name resolves among them, as
 * TypeScript resolves it from an App file.
 */
export interface KitTypes {
  readonly files: Readonly<Record<string, string>>;
  readonly resolved: Readonly<Record<string, string>>;
}

/** One type check: the App files it checks (paths relative to the App), and how. */
export interface TypeCheckRequest {
  readonly files: Readonly<Record<string, string>>;
  readonly options: CompilerOptions;
  /** The modules App files may resolve by name; any, when absent. */
  readonly allowed?: readonly string[];
}

/** `target`'s check of `files`, as the checker's isolate takes it over RPC. */
export const typeCheckRequest = (
  files: Readonly<Record<string, string>>,
  { options, allowed }: TypeTarget = generatedTarget
): TypeCheckRequest => ({
  files,
  options,
  ...(allowed === undefined ? {} : { allowed: [...allowed] }),
});

/** Where the kit's packages are, for a target that resolves any of them. */
const kitRoot = "/node_modules/";

/**
 * Where they are for a target that resolves only some (`allowed`): out of
 * reach of every App file's own lookup, which walks up its directories'
 * `node_modules` (no App path segment starts with a dot), so an App file
 * resolves by name only what `paths` maps (`allowed`, to where
 * `KitTypes.resolved` says), while the kit's own files resolve each other
 * as TypeScript does. A relative or absolute path into it is refused at
 * each file's compile, before its check counts (imports.ts).
 */
const hiddenKitRoot = "/.kit/node_modules/";

/** An App file a check reads: TypeScript, declarations included. */
const checkedFile = /^(?!\/)(?:[^/]+\/)*[^/]+\.tsx?$/u;

/** What no App file's path holds: a place the check's own files are. */
const reservedSegment = /(?:^|\/)(?:node_modules|\.kit)(?:\/|$)/u;

const severities: Partial<Record<number, Diagnostic["severity"]>> = {
  0: "warning",
  1: "error",
};

/** A diagnostic's message and its chain, as TypeScript flattens them, one level of indent each. */
const flattened = (diagnostic: TscDiagnostic, indent = 0): string =>
  [
    indent === 0 ? "" : `\n${"  ".repeat(indent)}`,
    diagnostic.text,
    ...(diagnostic.messageChain ?? []).map((next) =>
      flattened(next, indent + 1)
    ),
  ].join("");

/** A refusal of the check as a whole: never a pass. */
const stopped = (message: string): Diagnostic[] => [
  { rule: "check", severity: "error", message },
];

/** Where JavaScript ends a line, as TypeScript counts lines. */
const lineBreak = /\r\n?|[\n\u2028\u2029]/u;

/** Where `position` (UTF-16 offset) is in `text`: 1-based. */
const lineAndColumn = (
  text: string,
  position: number
): { line: number; column: number } => {
  const before = text.slice(0, position).split(lineBreak);
  return {
    line: before.length,
    column: (before.at(-1)?.length ?? 0) + 1,
  };
};

/** One run of tsc as `typeCheck` reads it: its exit, its JSON reply, and what it said on stderr. */
export interface TscRun {
  readonly exitCode: number;
  readonly reply: Uint8Array;
  readonly stderr: string;
}

/**
 * What a run of tsc says of the App's `files`, the kit's files under
 * `root` left out. A run that crashed (a type that recurses past the
 * stack), ended otherwise than tsc ends, or failed without one error to
 * say why is a refused check, never a pass.
 */
export const diagnosticsOfRun = (
  { exitCode, reply, stderr }: TscRun,
  { files, root }: { files: Readonly<Record<string, string>>; root: string }
): Diagnostic[] => {
  const said = stderr.trim().split("\n")[0] ?? "";
  const because = said === "" ? "" : `: ${said}`;
  if (exitCode === EXIT_CRASHED) {
    return stopped(
      `The type check stopped before it finished${because}. Simplify the App's types (a type that recurses without end overflows the type checker).`
    );
  }
  let all: TscDiagnostic[];
  try {
    all = parseReply(reply);
  } catch {
    return stopped(`The type check's answer couldn't be read${because}.`);
  }
  // 0: no errors; 1 and 2: errors (with and without output). Anything
  // else (an invalid project), or a failure that names no error, checked
  // nothing.
  if (
    exitCode > 2 ||
    (exitCode !== 0 && !all.some(({ category }) => category === 1))
  ) {
    return stopped(
      `The type check couldn't run (tsc exited with ${exitCode})${because}.`
    );
  }
  const own = new Set(Object.keys(files).map((path) => `/${path}`));
  return all.flatMap((diagnostic): Diagnostic[] => {
    const severity = severities[diagnostic.category];
    const { fileName } = diagnostic;
    if (severity === undefined || fileName?.startsWith(root) === true) {
      return [];
    }
    const result: Diagnostic = {
      rule: `TS${diagnostic.code}`,
      severity,
      // A module of the kit by where it was before the check hid it.
      message: flattened(diagnostic).replaceAll(root, kitRoot),
    };
    // Anything but an App file (the tsconfig the check wrote) is the
    // program's own, about the App as a whole.
    if (fileName === undefined || !own.has(fileName)) {
      return [result];
    }
    const file = fileName.slice(1);
    const at =
      diagnostic.startPosition === undefined
        ? lineAndColumn(files[file] ?? "", diagnostic.pos)
        : {
            line: diagnostic.startPosition.line + 1,
            column: diagnostic.startPosition.character + 1,
          };
    return [{ ...result, file, ...at }];
  });
};

/**
 * Type-checks the App files of `request` (paths relative to the App, e.g.
 * `screens/desk.tsx`) against `kit`, with tsrs's `module`, and the App's
 * own declaration files among them, which are checked too. Only the App
 * files' diagnostics and the program's own count, never the kit's. A run
 * that crashed (a type that recurses past the stack) or ended otherwise
 * than tsc ends is a failed check, never a pass.
 */
export const typeCheck = (
  module: WebAssembly.Module,
  kit: KitTypes,
  { files, options, allowed }: TypeCheckRequest
): Diagnostic[] => {
  const app = Object.keys(files);
  const strays = app.filter(
    (path) => !checkedFile.test(path) || reservedSegment.test(path)
  );
  if (strays.length > 0) {
    return stopped(
      `The type check reads only the App's TypeScript files: ${strays.join(", ")} can't be one.`
    );
  }
  const root = allowed === undefined ? kitRoot : hiddenKitRoot;
  const memory: Record<string, string> = {};
  for (const [path, text] of Object.entries(kit.files)) {
    memory[`${root}${path.slice(kitRoot.length)}`] = text;
  }
  const paths: Record<string, unknown> = {};
  if (allowed !== undefined) {
    for (const name of allowed) {
      const resolved = kit.resolved[name];
      if (resolved !== undefined) {
        paths[name] = [`.${root}${resolved.slice(kitRoot.length)}`];
      }
    }
  }
  const given = options.paths;
  Object.assign(paths, typeof given === "object" ? given : {});
  for (const [path, text] of Object.entries(files)) {
    memory[`/${path}`] = text;
  }
  memory["/tsconfig.json"] = JSON.stringify({
    compilerOptions: {
      ...options,
      paths,
      // The kit's declarations are never checked (only App files'
      // diagnostics count), and skipping them is most of a check's time:
      // only an App with declaration files of its own, which must be
      // checked, has the library checked with them.
      skipLibCheck: !app.some((path) => path.endsWith(".d.ts")),
    },
    files: app.map((path) => `./${path}`),
  });
  const errors: string[] = [];
  const decoder = new TextDecoder();
  const { exitCode, reply } = runTsc(
    module,
    makeRequest(["-p", "/tsconfig.json"], { cwd: "/", json: true }),
    memoryFileSystem(memory),
    {
      env: {},
      stderr: (chunk) => {
        errors.push(decoder.decode(chunk, { stream: true }));
      },
    }
  );
  return diagnosticsOfRun(
    { exitCode, reply, stderr: errors.join("") },
    { files, root }
  );
};
