/**
 * A standalone definition project's type check (`npm run typecheck`), as
 * scripts/package-definition-lib.ts writes it to `grasp/check.ts`, beside
 * `grasp/steering.ts`: this file and steering.ts, as they are. It checks
 * the App the way the platform does, so code that builds here builds on
 * Grasp, and code Grasp refuses fails here.
 *
 * Each kind of code is checked on its own, with its own tsconfig, as the
 * root tsconfig.json lists them: the compiler's own options for it
 * (type-check.ts), with the TypeScript the platform runs. Like the
 * platform, it reports only the App's own files, never the packages they
 * import, and holds them to what the platform does besides the options:
 *
 * - code whose types are checked (server code, workflows, compute
 *   modules) steers nothing: no triple-slash directive, no suppression
 *   (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`), no `declare
 *   global` or `declare module` (imports.ts, `typeChecked`);
 * - no App file references a type package or a lib, or a path that isn't
 *   one of the App's files (type-check.ts `referenceErrors`);
 * - an App file resolves by name only the modules its kind may import
 *   (`TypeTarget.allowed`, which each tsconfig's `grasp.allowed` lists).
 *
 * Run with Node, which strips its types: `node grasp/check.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { directiveIn } from "./steering.ts";

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
  /** Whether nothing in `file` may steer the check. */
  readonly steered: (file: string) => boolean;
  /** Whether `file`'s own type errors aren't yet the platform's. */
  readonly lenient: (file: string) => boolean;
}

const every = (): boolean => true;
const none = (): boolean => false;
const generated = (file: string): boolean => file.startsWith(".grasp/");
const workflow = (file: string): boolean => file.startsWith("workflows/");

/**
 * The kinds of code, as each tsconfig's `grasp.kind` names it. Server
 * code's migrations are checked for what they name, not yet for their
 * own type errors (compiler `checkAppCode`, GRA-690); a workflow's check
 * reads the App's server code for the types it names, reporting only the
 * workflows'; and the host's generated modules are its own.
 */
const kinds: Readonly<Record<string, Kind>> = {
  screens: { reports: every, steered: none, lenient: none },
  server: {
    reports: every,
    steered: (file) => !generated(file),
    lenient: (file) => file.startsWith("migrations/"),
  },
  workflows: { reports: workflow, steered: workflow, lenient: none },
  compute: { reports: every, steered: every, lenient: none },
  generated: { reports: every, steered: none, lenient: none },
};

/** `value`'s own `key`, when `value` is an object (parsed JSON). */
const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;

/** A tsconfig's `grasp`: its kind of code, and what it may import. */
const graspOf = (
  value: unknown
): { kind: Kind; allowed: ReadonlySet<string> | undefined } | undefined => {
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
  return Array.isArray(allowed) &&
    allowed.every((name) => typeof name === "string")
    ? { kind: known, allowed: new Set<string>(allowed) }
    : undefined;
};

const root = path.dirname(import.meta.dirname);

/** `file` as a path from `dir`, `/`-separated. */
const relativeTo = (dir: string, file: string): string =>
  path.relative(dir, file).split(path.sep).join("/");

const isWithin = (dir: string, file: string): boolean => {
  const relative = path.relative(dir, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    !relative.split(path.sep).includes("node_modules")
  );
};

const problemAt = (
  file: ts.SourceFile,
  position: number,
  code: string,
  message: string
): Problem => {
  const { line, character } = file.getLineAndCharacterOfPosition(position);
  return {
    file: file.fileName,
    line: line + 1,
    column: character + 1,
    code,
    message,
  };
};

/** Every comment in `file`: each token's leading and trailing trivia. */
const commentsOf = (file: ts.SourceFile): ts.CommentRange[] => {
  const text = file.getFullText();
  const found = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node): void => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      found.set(range.pos, range);
    }
    for (const child of node.getChildren(file)) {
      // A JSDoc comment is a comment, already found: what it holds isn't.
      if (
        child.kind < ts.SyntaxKind.FirstJSDocNode ||
        child.kind > ts.SyntaxKind.LastJSDocNode
      ) {
        visit(child);
      }
    }
  };
  visit(file);
  return [...found.values()].toSorted((a, b) => a.pos - b.pos);
};

/**
 * What in `file` would steer the check rather than be checked by it: a
 * comment TypeScript obeys as a directive (steering.ts, as the platform
 * reads them), and an ambient module or global declaration.
 */
const steeringIn = (file: ts.SourceFile): Problem[] => {
  const text = file.getFullText();
  const directives = commentsOf(file).flatMap(({ kind, pos, end }) => {
    const line = kind === ts.SyntaxKind.SingleLineCommentTrivia;
    const directive = directiveIn(
      line ? "line" : "block",
      text.slice(pos + 2, line ? end : end - 2)
    );
    return directive === undefined
      ? []
      : [
          problemAt(
            file,
            pos,
            "steering",
            `${directive} is never in this code: its type check is the platform's, as it is.`
          ),
        ];
  });
  const ambient: Problem[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isModuleDeclaration(node)) {
      if (ts.isStringLiteral(node.name)) {
        ambient.push(
          problemAt(
            file,
            node.getStart(file),
            "steering",
            `declare module "${node.name.text}" is never in this code: it would declare, or shadow, a module the SDK doesn't give it.`
          )
        );
      } else if (node.name.text === "global") {
        ambient.push(
          problemAt(
            file,
            node.getStart(file),
            "steering",
            "declare global is never in this code: it would declare globals its isolate doesn't have, for every file."
          )
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...directives, ...ambient];
};

/**
 * What `file`'s triple-slash directives reach beyond the App's files
 * (`app`): a reference path only to one of them, no type package and no
 * lib (type-check.ts `referenceErrors`).
 */
const referencesIn = (
  file: ts.SourceFile,
  app: ReadonlySet<string>
): Problem[] => [
  ...file.referencedFiles
    .filter(
      ({ fileName }) =>
        !app.has(path.resolve(path.dirname(file.fileName), fileName))
    )
    .map(({ fileName, pos }) =>
      problemAt(
        file,
        pos,
        "imports",
        `"${fileName}" is not one of the App's files: a reference path names only those.`
      )
    ),
  ...file.typeReferenceDirectives.map(({ fileName, pos }) =>
    problemAt(
      file,
      pos,
      "imports",
      `"${fileName}": App files reference no type packages; import what the kit has instead.`
    )
  ),
  ...file.libReferenceDirectives.map(({ fileName, pos }) =>
    problemAt(
      file,
      pos,
      "imports",
      `"${fileName}": App files reference no libs; their target's lib is the one they run with.`
    )
  ),
];

const fromDiagnostic = (diagnostic: ts.Diagnostic): Problem | undefined => {
  if (diagnostic.category !== ts.DiagnosticCategory.Error) {
    return undefined;
  }
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const { file, start } = diagnostic;
  if (file === undefined || start === undefined) {
    return {
      file: file?.fileName,
      line: undefined,
      column: undefined,
      code: `TS${diagnostic.code}`,
      message,
    };
  }
  return problemAt(file, start, `TS${diagnostic.code}`, message);
};

/** A tsconfig finding no files: a kind the App has none of. */
const noInputs = 18_003;

/** Checks one kind of code by its tsconfig, `config` from the root. */
const checkKind = (config: string): Problem[] => {
  const configPath = path.resolve(root, config);
  const read = ts.readConfigFile(configPath, (file) =>
    readFileSync(file, "utf-8")
  );
  const dir = path.dirname(configPath);
  const grasp = graspOf(fieldOf(read.config, "grasp"));
  if (read.error !== undefined || grasp === undefined) {
    return [
      {
        file: config,
        line: undefined,
        column: undefined,
        code: "config",
        message: "This isn't a tsconfig the project's check reads.",
      },
    ];
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dir,
    undefined,
    configPath
  );
  const errors = parsed.errors.filter(({ code }) => code !== noInputs);
  if (errors.length > 0 || parsed.fileNames.length === 0) {
    return errors.flatMap((diagnostic) => fromDiagnostic(diagnostic) ?? []);
  }
  const { kind, allowed } = grasp;
  // Code that steers the check never reaches it on the platform: its build
  // refuses it first, so a `/// <reference lib="dom" />` in one file can't
  // give every other file the DOM here either.
  const steering = parsed.fileNames
    .filter((file) => kind.steered(relativeTo(dir, file)))
    .flatMap((file) =>
      steeringIn(
        ts.createSourceFile(
          file,
          readFileSync(file, "utf-8"),
          ts.ScriptTarget.Latest,
          true
        )
      )
    );
  if (steering.length > 0) {
    return steering;
  }
  const app = new Set(parsed.fileNames.map((file) => path.resolve(file)));
  const mapped = new Set(Object.keys(parsed.options.paths ?? {}));
  const host = ts.createCompilerHost(parsed.options);
  const cache = ts.createModuleResolutionCache(
    dir,
    (file) => host.getCanonicalFileName(file),
    parsed.options
  );
  // As the platform resolves an App file's imports (type-check.ts
  // `resolvesWithin`): an App file by a relative path or a mapping, a
  // module by name only when its kind may import it. The packages' own
  // imports resolve as TypeScript does.
  host.resolveModuleNameLiterals = (
    literals,
    containingFile,
    redirectedReference,
    options
  ) =>
    literals.map(({ text }) => {
      const { resolvedModule } = ts.resolveModuleName(
        text,
        containingFile,
        options,
        host,
        cache,
        redirectedReference
      );
      if (
        allowed === undefined ||
        resolvedModule === undefined ||
        !isWithin(dir, containingFile)
      ) {
        return { resolvedModule };
      }
      const toApp = isWithin(dir, resolvedModule.resolvedFileName);
      const within = toApp
        ? text.startsWith("./") || text.startsWith("../") || mapped.has(text)
        : allowed.has(text);
      return { resolvedModule: within ? resolvedModule : undefined };
    });
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const checked = program
    .getSourceFiles()
    .filter((file) => app.has(path.resolve(file.fileName)))
    .filter((file) => kind.reports(relativeTo(dir, file.fileName)));
  const found = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...checked.flatMap((file) =>
      kind.lenient(relativeTo(dir, file.fileName))
        ? []
        : [
            ...program.getSyntacticDiagnostics(file),
            ...program.getSemanticDiagnostics(file),
          ]
    ),
  ].flatMap((diagnostic) => fromDiagnostic(diagnostic) ?? []);
  return [...found, ...checked.flatMap((file) => referencesIn(file, app))];
};

/** The tsconfigs the root tsconfig.json lists, one a kind of code. */
const configs = (): string[] => {
  const read = ts.readConfigFile(path.join(root, "tsconfig.json"), (file) =>
    readFileSync(file, "utf-8")
  );
  const references = fieldOf(read.config, "references");
  if (read.error !== undefined || !Array.isArray(references)) {
    throw new Error("tsconfig.json lists no tsconfigs to check.");
  }
  return references.map((reference: unknown) => {
    const configPath = fieldOf(reference, "path");
    if (typeof configPath !== "string") {
      throw new TypeError("tsconfig.json lists a tsconfig without its path.");
    }
    return configPath;
  });
};

const problems = configs().flatMap((config) => checkKind(config));
for (const { file, line, column, code, message } of problems) {
  const where =
    file === undefined
      ? ""
      : `${relativeTo(root, path.resolve(root, file))}${line === undefined ? "" : `(${line},${column})`}: `;
  process.stderr.write(`${where}error ${code}: ${message}\n`);
}
if (problems.length > 0) {
  process.exitCode = 1;
}
