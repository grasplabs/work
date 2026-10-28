import type {
  BuildOptions,
  BuildResult,
  Plugin,
} from "esbuild-wasm/esm/browser.js";

/**
 * A chat's preview as one ES module (spec 19.2.1): the App's modules a
 * screen loads, bundled into one entry, which the preview frame
 * evaluates for each update and React Fast Refresh swaps in. One module,
 * so the frame checks one size and one SHA-256 before it imports it as a
 * `data:` module (GRA-409), and so no update needs the frame's import map,
 * which can't change once modules loaded, to name new code. The kit's
 * modules stay outside it, imported by their flat names, which that
 * import map resolves to the same modules every update: one React, one
 * SDK client, one Refresh runtime for the whole session.
 *
 * esbuild bundles it, as it bundles an App's packages (packages/bundle.ts),
 * so the entry keeps ES module semantics rather than a loader of our own
 * approximating them: modules evaluate once, in import order; a module
 * awaiting at its top level is done before what imports it runs, however
 * many import it at once; cycles and dynamic imports resolve within the
 * entry. Nothing is recompiled: the modules come compiled and instrumented
 * for Refresh, and bundling only joins them, so it is measured on its own,
 * never claimed as a compile of unchanged source.
 */

/** esbuild's `build`, started: the isolate's own, or Node's in a test. */
export type Bundle = (
  options: BuildOptions & { write: false }
) => Promise<BuildResult<BuildOptions & { write: false }>>;

/** The namespace of the App's modules, which only this plugin loads. */
const appNamespace = "grasp-preview";

/**
 * What every import matches, for esbuild's plugin filters, which are Go
 * regular expressions: no `u` flag (esbuild refuses one).
 */
// oxlint-disable-next-line require-unicode-regexp
const anything = /.*/;

/** The prefix of each entry's own module, which no App module has. */
const entryModule = "grasp-preview-entry";

/** Why a bundle failed, in esbuild's words, one line each. */
const failureOf = (error: unknown): string => {
  const errors: unknown =
    typeof error === "object" && error !== null && "errors" in error
      ? error.errors
      : undefined;
  if (Array.isArray(errors)) {
    const texts = errors.flatMap((each: unknown) =>
      typeof each === "object" && each !== null && "text" in each
        ? [String(each.text)]
        : []
    );
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return error instanceof Error ? error.message : String(error);
};

/** One screen to bundle: its module and the App modules it loads, itself among them. */
export interface PreviewScreen {
  readonly closure: readonly string[];
  /** The kit modules its closure imports, by flat name. */
  readonly kitModules: readonly string[];
}

/** An entry's own module: the screen's default export, and only that. */
const entryModuleOf = (index: number): string => `${entryModule}-${index}`;

/**
 * Each screen's entry, by its module's name: the App's `modules` in its
 * closure, bundled by `bundle` with the kit modules they import left
 * outside. One esbuild run for every screen, so a module two screens load
 * is read once. Each entry's default export is its screen's component.
 * Deterministic: the same modules make the same entries, byte for byte.
 */
export const previewEntries = async (
  {
    screens,
    modules,
  }: {
    screens: Readonly<Record<string, PreviewScreen>>;
    modules: Readonly<Record<string, string>>;
  },
  bundle: Bundle
): Promise<Record<string, string>> => {
  const entries = Object.keys(screens).toSorted();
  const own = new Set<string>();
  const kit = new Set<string>();
  for (const entry of entries) {
    const screen = screens[entry];
    if (screen === undefined || !screen.closure.includes(entry)) {
      throw new Error(
        `The preview's closure doesn't hold its entry, ${entry}.`
      );
    }
    for (const name of screen.closure) {
      if (modules[name] === undefined) {
        throw new Error(
          `The preview's closure names ${name}, which is missing.`
        );
      }
      own.add(name);
    }
    for (const name of screen.kitModules) {
      kit.add(name);
    }
  }
  if (entries.length === 0) {
    return {};
  }
  // A closure holds every App module its modules import, so only an
  // import of a module outside every closure, or of nothing, is refused.
  const entryModules = new Map(
    entries.map((entry, index) => [entryModuleOf(index), entry])
  );
  const resolver: Plugin = {
    name: "grasp-preview",
    setup: (build) => {
      // Every import resolves here: a kit module stays outside, an App
      // module of a closure comes from `modules`, and nothing else is read
      // from anywhere.
      build.onResolve({ filter: anything }, ({ path }) => {
        if (entryModules.has(path) || own.has(path)) {
          return { path, namespace: appNamespace };
        }
        if (kit.has(path)) {
          return { path, external: true };
        }
        return { errors: [{ text: `The preview has no module ${path}.` }] };
      });
      build.onLoad(
        { filter: anything, namespace: appNamespace },
        ({ path }) => {
          const entry = entryModules.get(path);
          return {
            contents:
              entry === undefined
                ? (modules[path] ?? "")
                : `export { default } from ${JSON.stringify(entry)};`,
            loader: "js",
          };
        }
      );
    },
  };
  let outputs: { path: string; text: string }[];
  try {
    const result = await bundle({
      entryPoints: Object.fromEntries(
        [...entryModules.keys()].map((name) => [name, name])
      ),
      bundle: true,
      write: false,
      format: "esm",
      splitting: false,
      platform: "neutral",
      target: "es2022",
      mainFields: [],
      conditions: [],
      outdir: "/preview",
      entryNames: "[name]",
      // esbuild names it so (unicorn would have it "utf-8").
      // oxlint-disable-next-line unicorn/text-encoding-identifier-case
      charset: "utf8",
      legalComments: "none",
      logLevel: "silent",
      plugins: [resolver],
    });
    outputs = result.outputFiles;
  } catch (error) {
    throw new Error(`The preview's entry didn't bundle: ${failureOf(error)}`, {
      cause: error,
    });
  }
  const bundled = new Map(outputs.map(({ path, text }) => [path, text]));
  return Object.fromEntries(
    [...entryModules].map(([name, entry]) => {
      const text = bundled.get(`/preview/${name}.js`);
      if (text === undefined) {
        throw new Error(`The preview's entry for ${entry} didn't bundle.`);
      }
      return [entry, text];
    })
  );
};
