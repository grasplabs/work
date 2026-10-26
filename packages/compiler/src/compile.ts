import Babel from "@babel/standalone";
import reactCompiler from "babel-plugin-react-compiler";
import reactRefresh from "react-refresh/babel";

/**
 * The directives that switch the React Compiler off for the function (or
 * module) that holds them, as it matches them: exactly this text.
 */
const compilerOptOuts: ReadonlySet<string> = new Set([
  "use no memo",
  "use no forget",
]);

/** What `refuseCompilerOptOuts` reads of a Babel directive's path. */
interface DirectivePath {
  node: { value: { value: string } };
  buildCodeFrameError: (message: string) => Error;
}

/**
 * A Babel plugin that refuses a directive switching the React Compiler off
 * (`compilerOptOuts`), in any function body or the module's prologue,
 * before the compiler runs: a component it skips would ship code it
 * rejects, and every component goes through it (spec 19.1). Only a
 * directive is refused; a string or a comment that names one is not.
 */
const refuseCompilerOptOuts = () => ({
  visitor: {
    Program: (program: {
      traverse: (visitor: { Directive: (path: DirectivePath) => void }) => void;
    }) => {
      program.traverse({
        Directive: (directive) => {
          const { value } = directive.node.value;
          if (compilerOptOuts.has(value)) {
            throw directive.buildCodeFrameError(
              `"${value}" is never in App code: it would switch the React Compiler off, and every component goes through it. Fix what the compiler refuses instead.`
            );
          }
        },
      });
    },
  },
});

/**
 * What a preview build's modules call to register their components with
 * React Fast Refresh, and to track their hooks (spec 19.2.1): names no
 * App code has reason to use, which the module's header defines
 * (`refreshHeader`).
 */
export const refreshNames = {
  register: "__graspRefreshReg",
  signature: "__graspRefreshSig",
} as const;

/** How a module is compiled. */
export interface CompileOptions {
  /**
   * For a chat's preview (spec 19.2.1): instrumented for React Fast
   * Refresh, after the React Compiler, which resets a component's memo
   * cache when its source changes. Never for production.
   */
  readonly refresh?: boolean;
}

/**
 * Compiles one TypeScript or TSX file to a JavaScript module in one Babel
 * pass: the React Compiler, then types stripped and JSX turned into calls to
 * `react/jsx-runtime`. `plugins` run first, on the source as written. Like
 * the frontend's build, it throws on anything the React Compiler can't
 * compile, and refuses a directive that would switch it off
 * (`refuseCompilerOptOuts`). `enableReanimatedCheck` is off: the check
 * calls `require.resolve`, which a Worker doesn't have.
 *
 * With `refresh`, the React Compiler resets a component's memo cache when
 * its source changes, and React Fast Refresh's instrumentation runs after
 * it, in the same pass, as React's own tooling orders them: each component
 * is registered through `refreshNames`, with its full hook signature (no
 * hashing, which would need Node's crypto).
 */
export const compileModule = (
  source: string,
  filename: string,
  plugins: unknown[] = [],
  { refresh = false }: CompileOptions = {}
): string => {
  const isTSX = filename.endsWith(".tsx");
  // Babel unwraps the plugin's CommonJS default export itself, the same way
  // under Node (the kit build) and in the bundled compiler.
  const { code } = Babel.transform(source, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    plugins: [
      refuseCompilerOptOuts,
      ...plugins,
      [
        reactCompiler,
        {
          target: "19",
          panicThreshold: "all_errors",
          enableReanimatedCheck: false,
          // Set either way: left out, it is on whenever the compiling
          // process has NODE_ENV=development, and the same file would
          // compile to other code depending on who built it. On only for
          // a preview, whose components Fast Refresh swaps.
          environment: { enableResetCacheOnSourceFileChanges: refresh },
        },
      ],
      ...(refresh
        ? [
            [
              reactRefresh,
              {
                skipEnvCheck: true,
                emitFullSignatures: true,
                refreshReg: refreshNames.register,
                refreshSig: refreshNames.signature,
              },
            ],
          ]
        : []),
    ],
    // Presets run after plugins, in reverse order: types go first.
    presets: [
      ["react", { runtime: "automatic" }],
      ["typescript", { isTSX, allExtensions: true }],
    ],
  });
  return code ?? "";
};

/**
 * Compiles one TypeScript file to a JavaScript module by stripping its
 * types, nothing else: server code, which has no JSX or React. `plugins`
 * run first, on the source as written.
 */
export const stripTypes = (
  source: string,
  filename: string,
  plugins: unknown[] = []
): string =>
  Babel.transform(source, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    plugins,
    presets: [["typescript", { allExtensions: true }]],
  }).code ?? "";

/** Runs Babel plugins over a JavaScript module, e.g. to rewrite its imports. */
export const transformModule = (
  code: string,
  filename: string,
  plugins: unknown[]
): string =>
  Babel.transform(code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    compact: true,
    plugins,
  }).code ?? "";
