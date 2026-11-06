import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Babel from "@babel/standalone";
import type { SurfaceKind } from "@grasp-os/shared/pages";
import { surfaceKinds } from "@grasp-os/shared/pages";
import {
  Generator,
  getConfig,
  inferFullPath,
} from "@tanstack/router-generator";
import type { RouteNode } from "@tanstack/router-generator";

import type { Diagnostic } from "./diagnostic.ts";
import { isPageFile, pagesFolder, rootPage, routeTreePath } from "./inputs.ts";
import { problem } from "./refusals.ts";
import { parserPlugins } from "./steering.ts";

// An App's pages are TanStack Router file routes under `src/routes/`
// (`index.tsx` is `/`, `tasks.$taskId.tsx` is `/tasks/$taskId`,
// `__root.tsx` the layout around them), and their route tree is what
// TanStack's own generator makes of them, unchanged: the files go into
// the isolate's in-memory `node:fs`, where the generator crawls them as it
// would a disk, and the tree it writes is read back. Nothing of ours
// decides what a file's route is.

/**
 * A place the host opens one of an App's pages besides its route (spec
 * 34.1): what the page's file exports as its `surface`.
 */
export interface SurfaceManifest {
  /** Its page's route, as TanStack names it: `/`, `/settings`. */
  readonly path: string;
  readonly kind: SurfaceKind;
  /** What the host calls it, 1 to 100 characters. */
  readonly title: string;
}

/**
 * The route tree of an App's pages, as far as there is one: the generated
 * module and the surfaces its pages declare, and what is wrong with them,
 * which fails the build beside whatever else its files' checks find.
 */
export interface RouteTree {
  /** The generated module, `src/routeTree.gen.ts`; none if the generator refused. */
  source: string | undefined;
  /**
   * The route files as the generator left them: it writes each one's
   * `createFileRoute("…")` path as its file names it, as TanStack's own
   * plugin does in a project, so the build compiles what the tree routes.
   */
  routes: Record<string, string>;
  /** The surfaces its pages declare, by their routes' paths. */
  surfaces: SurfaceManifest[];
  diagnostics: Diagnostic[];
}

/**
 * What the generated tree ends with: the router's type for the App's
 * code, so `Link`, `useNavigate` and `Route.useParams()` are typed by its
 * routes, as an App's `main.tsx` would register it.
 */
const registerRouter = [
  'import type { Router } from "@tanstack/react-router";',
  'declare module "@tanstack/react-router" {',
  "  interface Register {",
  "    router: Router<typeof routeTree>;",
  "  }",
  "}",
];

const surfaceTitleMax = 100;

/** What the surface reader reads of Babel's nodes. */
interface Node {
  type: string;
  loc?: { start: { line: number; column: number } } | null;
  name?: string;
  value?: unknown;
  kind?: string;
  id?: Node;
  init?: Node | null;
  key?: Node;
  computed?: boolean;
  expression?: Node;
  declaration?: Node | null;
  declarations?: Node[];
  properties?: Node[];
}

const surfaceShape =
  'A page\'s surface is `export const surface = { kind: "sidebar" | "panel" | "settings", title: "…" }`, with literal values.';

/** `node` without the type assertions around it (`as const`, `satisfies`). */
const unwrapped = (node: Node | null | undefined): Node | undefined => {
  let current = node ?? undefined;
  while (
    current !== undefined &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "ParenthesizedExpression")
  ) {
    current = current.expression;
  }
  return current;
};

/** A property's literal string value, by its key's name. */
const stringProperties = (
  object: Node
): Map<string, string | undefined> | undefined => {
  const read = new Map<string, string | undefined>();
  for (const property of object.properties ?? []) {
    if (property.type !== "ObjectProperty" || property.computed === true) {
      return undefined;
    }
    const key = property.key?.name ?? property.key?.value;
    if (typeof key !== "string") {
      return undefined;
    }
    // SAFETY: an object property's value is an expression node, which
    // `unwrapped` reads only by its `type`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const value = unwrapped(property.value as Node | undefined);
    read.set(
      key,
      value?.type === "StringLiteral" && typeof value.value === "string"
        ? value.value
        : undefined
    );
  }
  return read;
};

/**
 * The `surface` a page's file exports, read from its syntax alone: the
 * host lists an App's surfaces without running its code. Undefined for a
 * file that exports none, or doesn't parse (its compile says why).
 */
const surfaceOf = (
  file: string,
  source: string
): { surface?: Omit<SurfaceManifest, "path">; errors: Diagnostic[] } => {
  const declared: Node[] = [];
  const collect = () => ({
    visitor: {
      ExportNamedDeclaration: (visited: { node: Node }) => {
        const { declaration } = visited.node;
        if (declaration?.type !== "VariableDeclaration") {
          return;
        }
        for (const each of declaration.declarations ?? []) {
          if (each.id?.name === "surface") {
            declared.push({ ...each, kind: declaration.kind });
          }
        }
      },
    },
  });
  try {
    Babel.transform(source, {
      filename: file,
      babelrc: false,
      configFile: false,
      sourceType: "module",
      code: false,
      parserOpts: { plugins: parserPlugins(file) },
      plugins: [collect],
    });
  } catch {
    return { errors: [] };
  }
  const [found] = declared;
  if (found === undefined) {
    return { errors: [] };
  }
  const at = {
    file,
    ...(found.loc === null || found.loc === undefined
      ? {}
      : { line: found.loc.start.line, column: found.loc.start.column + 1 }),
  };
  const object = unwrapped(found.init);
  const read =
    found.kind === "const" && object?.type === "ObjectExpression"
      ? stringProperties(object)
      : undefined;
  const kind = read?.get("kind");
  const title = read?.get("title");
  if (
    read === undefined ||
    read.size !== 2 ||
    kind === undefined ||
    title === undefined ||
    !surfaceKinds.some((each) => each === kind)
  ) {
    return { errors: [problem("surfaces", surfaceShape, at)] };
  }
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > surfaceTitleMax) {
    return {
      errors: [
        problem(
          "surfaces",
          `A surface's title is 1 to ${String(surfaceTitleMax)} characters.`,
          at
        ),
      ],
    };
  }
  return {
    // SAFETY: one of `surfaceKinds`, checked above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    surface: { kind: kind as SurfaceKind, title: trimmed },
    errors: [],
  };
};

/**
 * Where a route is in the App's address: its path as a link names it
 * (`inferFullPath`, TanStack's own), without the route ID's pathless
 * layouts (`_layout`), groups (`(admin)`) or un-nesting (`tasks_`), and
 * without an index route's trailing `/`.
 */
const addressOf = (node: RouteNode): string => {
  const full = inferFullPath(node);
  return full.length > 1 ? full.replace(/\/$/u, "") : full;
};

/**
 * Why a surface can't open `node`: the host opens a surface at its route
 * alone, so it needs one that is a page in itself, with no parameters to
 * fill. Undefined when it can.
 */
const surfaceRefusal = (node: RouteNode): string | undefined => {
  if (
    node._fsRouteType === "__root" ||
    node._fsRouteType === "layout" ||
    node._fsRouteType === "pathless_layout"
  ) {
    return "A surface opens a page, never a layout around others: export it from the page itself.";
  }
  if (addressOf(node).includes("$")) {
    return "A surface opens a page of its own without parameters: the host has none to give it.";
  }
  return undefined;
};

/** What the generator threw, without its temporary directory, at the file it names. */
const generatorProblem = (error: unknown, root: string): Diagnostic => {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).replaceAll(`${root}/`, "");
  const file = /(?<file>src\/routes\/\S+\.tsx?)/u.exec(message)?.groups?.file;
  return problem("routes", message, file === undefined ? {} : { file });
};

/**
 * Whether `source` parses: a file that doesn't is left to its compile,
 * which says where, rather than failing the generator for every page.
 */
const parses = (file: string, source: string): boolean => {
  try {
    Babel.transform(source, {
      filename: file,
      babelrc: false,
      configFile: false,
      sourceType: "module",
      code: false,
      parserOpts: { plugins: parserPlugins(file) },
      plugins: [],
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * The route tree of `files`' pages (`src/routes/**`), as TanStack's
 * generator makes it, with the surfaces its pages declare, and why the
 * generator refused them, a page exports no route or a surface is
 * malformed.
 */
export const routeTree = async (
  files: Readonly<Record<string, string>>
): Promise<RouteTree> => {
  const routes = Object.entries(files).filter(
    ([file, source]) => file.startsWith(pagesFolder) && parses(file, source)
  );
  const root = path.join(tmpdir(), `routes-${crypto.randomUUID()}`);
  let nodes: RouteNode[] = [];
  try {
    for (const [file, source] of routes) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
    }
    // A config of ours alone: `getConfig` reads a `tsr.config.json` from
    // the directory it is given, and none is ever written there.
    const config = getConfig(
      {
        target: "react",
        routesDirectory: path.join(root, pagesFolder),
        generatedRouteTree: path.join(root, routeTreePath),
        enableRouteTreeFormatting: false,
        disableLogging: true,
        routeTreeFileFooter: registerRouter,
        tmpDir: path.join(root, ".tanstack"),
        plugins: [
          {
            name: "grasp-pages",
            onRouteTreeChanged: ({ routeNodes }) => {
              nodes = routeNodes;
            },
          },
        ],
      },
      path.join(root, "config")
    );
    try {
      await new Generator({ config, root }).run();
    } catch (error) {
      return {
        source: undefined,
        routes: {},
        surfaces: [],
        diagnostics: [generatorProblem(error, root)],
      };
    }
    const source = readFileSync(path.join(root, routeTreePath), "utf-8");
    const rewritten = Object.fromEntries(
      routes.map(([file]) => [
        file,
        readFileSync(path.join(root, file), "utf-8"),
      ])
    );
    // A file the generator left out of the tree exports no route: TanStack
    // passes over it without a word, so it is said here, where the App's
    // author finds out why the page doesn't show.
    const placed = new Set(
      nodes.map(({ filePath }) => `${pagesFolder}${filePath}`)
    );
    const errors: Diagnostic[] = routes
      .filter(
        ([file]) =>
          isPageFile(file) &&
          file !== rootPage &&
          !placed.has(file) &&
          !file.split("/").some((segment) => segment.startsWith("-"))
      )
      .map(([file]) =>
        problem(
          "routes",
          'A page exports its route: `export const Route = createFileRoute("/path")({ component })`.',
          { file }
        )
      );
    const surfaces: SurfaceManifest[] = [];
    for (const node of nodes) {
      const file = path.relative(
        root,
        path.join(root, pagesFolder, node.filePath)
      );
      const read = surfaceOf(file, files[file] ?? "");
      errors.push(...read.errors);
      if (read.surface === undefined) {
        continue;
      }
      const refusal = surfaceRefusal(node);
      if (refusal !== undefined) {
        errors.push(problem("surfaces", refusal, { file }));
        continue;
      }
      surfaces.push({ path: addressOf(node), ...read.surface });
    }
    return {
      source,
      routes: rewritten,
      surfaces: surfaces.toSorted((a, b) => (a.path < b.path ? -1 : 1)),
      diagnostics: errors,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
