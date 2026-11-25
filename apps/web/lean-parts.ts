import path from "node:path";

import {
  createCompiledCatalog,
  getCatalogForFile,
  getCatalogs,
} from "@lingui/cli/api";
import type { LinguiConfigNormalized } from "@lingui/conf";
import { Features, transform } from "lightningcss";
import type { Rule, StyleSheet } from "lightningcss";
import type { Plugin } from "vite-plus";

import {
  leanPages,
  leanStylesMeta,
  wholeStylesMeta,
} from "./src/lean-pages.ts";

// The lean pages (src/lean-pages.ts) load a lean part of the app's
// stylesheet and of their language's catalog: what the modules they can
// run use, worked out here from the build's own module graph. Every other
// page loads the whole, as before (src/page-parts.ts).
//
// A module "they can run" is one the app's entry imports, or a lean page's
// route, or any module those import, statically or not, but never another
// route's page or a catalog. Whatever else that takes in (the entry still
// imports much of the app) only makes the lean part bigger, never short.
//
// - A catalog imported as `messages.po?lean` keeps only the messages whose
//   ids those modules hold. It is filled in as its chunk is written, before
//   the chunk's name is hashed, so the name changes with what it holds.
// - The stylesheet's lean copy drops the rules made for class names no such
//   module holds: StyleX's atomic rules and Tailwind's utilities, never a
//   rule written by hand. Its rules keep their order, so with the whole
//   stylesheet loaded after it every rule still wins as in the whole alone.
//   index.html links neither: it names both in meta tags, for the app to
//   load the one the page needs (src/page-parts.ts) and the preload script
//   to fetch it early (locale-preload.ts).
//
// Out of a build (the dev server, tests) a `?lean` catalog is the whole
// catalog and the stylesheet stays whole: everything is there to look up.

const leanSuffix = "?lean";
// Not ending in `.po`, which the Lingui plugin would compile whole.
const leanCatalogId = "\0lean-catalog:";
const leanCatalogEnd = ".lean";

/**
 * What a module's code may name a class or a message by: its runs between
 * quotes and blanks. Splitting a Tailwind class such as `w-[calc(100%-1px)]`
 * apart would lose it, so brackets stay in.
 */
const tokenBreak = /[\s"'`]+/u;

/** StyleX's atomic class names: `x` and a hash, as `x1rhsv17`. */
const stylexClass = /^x[a-z\d]{4,10}$/u;

/** Every class name a selector (or anything) holds, at any depth. */
const classNames = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) {
    for (const each of value) {
      classNames(each, found);
    }
  } else if (typeof value === "object" && value !== null) {
    const fields = new Map<string, unknown>(Object.entries(value));
    const name = fields.get("name");
    if (fields.get("type") === "class" && typeof name === "string") {
      found.push(name);
    }
    for (const each of fields.values()) {
      classNames(each, found);
    }
  }
  return found;
};

/** The class names Tailwind's `utilities` layer makes rules for. */
const utilityClasses = (css: Buffer): Set<string> => {
  const found = new Set<string>();
  const visit = (rules: readonly Rule[], inUtilities: boolean): void => {
    for (const rule of rules) {
      if (rule.type === "style") {
        if (inUtilities) {
          for (const name of classNames(rule.value.selectors)) {
            found.add(name);
          }
        }
      } else if (
        rule.type === "media" ||
        rule.type === "supports" ||
        rule.type === "container" ||
        rule.type === "layer-block"
      ) {
        visit(
          rule.value.rules,
          inUtilities ||
            (rule.type === "layer-block" &&
              rule.value.name?.join(".") === "utilities")
        );
      }
    }
  };
  transform({
    filename: "whole.css",
    code: css,
    visitor: {
      StyleSheet: (sheet: StyleSheet) => {
        visit(sheet.rules, false);
      },
    },
  });
  return found;
};

/**
 * The lean copy of the stylesheet `css`, for the class names in `used`: a
 * rule goes when it names classes, none of which is used, and all of which
 * were generated, by Tailwind's `utilities` layer or by StyleX. A rule only
 * goes: one changed would be written back from Lightning CSS's own tree,
 * which doesn't read back every rule it writes.
 */
export const leanStylesheet = (
  css: string,
  used: ReadonlySet<string>
): string => {
  const code = Buffer.from(css);
  const utilities = utilityClasses(code);
  return transform({
    filename: "lean.css",
    code,
    minify: true,
    // Written for the same browsers already: nothing to lower again, and
    // Damsko's `light-dark()` stays as it is (vite.config.ts).
    exclude: Features.LightDark,
    visitor: {
      Rule: {
        style: (rule) => {
          const names = classNames(rule.value.selectors);
          const generated =
            names.length > 0 &&
            names.every(
              (name) => stylexClass.test(name) || utilities.has(name)
            );
          return generated && !names.some((name) => used.has(name))
            ? []
            : undefined;
        },
      },
    },
  }).code.toString();
};

/** The ids of the modules the lean pages can run, from the build's graph. */
interface Graph {
  ids: () => Iterable<string>;
  info: (id: string) =>
    | {
        isEntry: boolean;
        importedIds: readonly string[];
        dynamicallyImportedIds: readonly string[];
      }
    | null
    | undefined;
}

const isRouteSplit = (id: string): boolean => id.includes("?tsr-split");
const isCatalog = (id: string): boolean =>
  id.startsWith(leanCatalogId) || id.split("?")[0]?.endsWith(".po") === true;

export const leanModules = (graph: Graph, routesDir: string): Set<string> => {
  const leanRoutes = new Set(
    leanPages.map(({ route }) => path.join(routesDir, route))
  );
  const roots = [...graph.ids()].filter(
    (id) =>
      graph.info(id)?.isEntry === true ||
      (isRouteSplit(id) && leanRoutes.has(id.split("?")[0] ?? ""))
  );
  const seen = new Set<string>();
  const next = [...roots];
  for (let id = next.pop(); id !== undefined; id = next.pop()) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const info = graph.info(id);
    if (info) {
      next.push(
        ...info.importedIds,
        ...info.dynamicallyImportedIds.filter(
          (each) =>
            !isCatalog(each) &&
            !(isRouteSplit(each) && !leanRoutes.has(each.split("?")[0] ?? ""))
        )
      );
    }
  }
  return seen;
};

/** The raw messages of the catalog file `file`, in its language. */
const translations = async (
  config: LinguiConfigNormalized,
  file: string
): Promise<{ locale: string; messages: Record<string, string> }> => {
  const found = getCatalogForFile(
    path.relative(config.rootDir, file),
    await getCatalogs(config)
  );
  if (!found) {
    throw new Error(`lean-parts: ${file} is no catalog of lingui.config.ts`);
  }
  const { locale, catalog } = found;
  const { messages } = await catalog.getTranslations(locale, {
    fallbackLocales: config.fallbackLocales,
    sourceLocale: config.sourceLocale,
  });
  return { locale, messages };
};

/** Every token the lean modules hold. */
const usedTokens = (
  context: {
    getModuleIds: () => IterableIterator<string>;
    getModuleInfo: Graph["info"];
  },
  tokens: ReadonlyMap<string, ReadonlySet<string>>,
  routesDir: string
): Set<string> => {
  const used = new Set<string>();
  const modules = leanModules(
    {
      ids: () => context.getModuleIds(),
      info: (id) => context.getModuleInfo(id),
    },
    routesDir
  );
  for (const id of modules) {
    for (const token of tokens.get(id) ?? []) {
      used.add(token);
    }
  }
  return used;
};

export const leanParts = ({
  linguiConfig,
}: {
  linguiConfig: LinguiConfigNormalized;
}): Plugin[] => {
  let building = false;
  let base = "/";
  let routesDir = "";
  /** Each module's tokens: what its code may name a class or message by. */
  const tokens = new Map<string, Set<string>>();
  /** Each lean catalog's placeholder, and the catalog it stands for. */
  const catalogs = new Map<
    string,
    { locale: string; messages: Record<string, string> }
  >();
  let used: Set<string> | undefined;

  /**
   * Before Vite writes, into index.html and each chunk's preload list, the
   * stylesheet the chunks import (main.tsx): a lean page would load the
   * whole with them. The app links the one it needs itself.
   */
  const unlinkStyles: Plugin = {
    name: "grasp:lean-parts-unlink-styles",
    apply: "build",
    generateBundle: {
      order: "pre",
      handler(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk") {
            output.viteMetadata?.importedCss.clear();
          }
        }
      },
    },
  };

  const parts: Plugin = {
    name: "grasp:lean-parts",
    configResolved: (config) => {
      building = config.command === "build";
      ({ base } = config);
      routesDir = path.join(config.root, "src", "routes");
    },
    buildStart: () => {
      tokens.clear();
      catalogs.clear();
      used = undefined;
    },
    resolveId: {
      order: "pre",
      handler(source, importer) {
        if (!source.endsWith(`.po${leanSuffix}`) || importer === undefined) {
          return null;
        }
        const file = path.resolve(
          path.dirname(importer),
          source.slice(0, -leanSuffix.length)
        );
        return building ? `${leanCatalogId}${file}${leanCatalogEnd}` : file;
      },
    },
    async load(id) {
      if (!id.startsWith(leanCatalogId)) {
        return null;
      }
      const file = id.slice(leanCatalogId.length, -leanCatalogEnd.length);
      this.addWatchFile(file);
      const catalog = await translations(linguiConfig, file);
      // A name the chunk keeps as it is, for the lean messages to replace.
      const placeholder = `__grasp_lean_catalog_${catalog.locale.replaceAll(/\W/gu, "_")}__`;
      catalogs.set(placeholder, catalog);
      return {
        code: `export const messages = JSON.parse(${placeholder});`,
        moduleType: "js",
      };
    },
    transform(code, id) {
      if (building && !id.startsWith(leanCatalogId)) {
        tokens.set(id, new Set(code.split(tokenBreak)));
      }
      return null;
    },
    renderChunk(code) {
      const placeholder = [...catalogs.keys()].find((each) =>
        code.includes(each)
      );
      if (placeholder === undefined) {
        return null;
      }
      used ??= usedTokens(this, tokens, routesDir);
      const { locale, messages } = catalogs.get(placeholder) ?? {};
      if (locale === undefined || messages === undefined) {
        return null;
      }
      const lean = Object.fromEntries(
        Object.entries(messages).filter(([id]) => used?.has(id) === true)
      );
      // As JSON: `{"messages": {…}}`.
      const { source, errors } = createCompiledCatalog(locale, lean, {
        namespace: "json",
      });
      const parsed: unknown = JSON.parse(source);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("messages" in parsed)
      ) {
        throw new Error(`lean-parts: Lingui compiled ${locale} as no catalog`);
      }
      const { messages: compiled } = parsed;
      if (errors.length > 0) {
        this.warn(
          `lean-parts: ${errors.length} messages of ${locale} don't compile`
        );
      }
      return {
        code: code.replace(
          placeholder,
          JSON.stringify(JSON.stringify(compiled))
        ),
        map: null,
      };
    },
    generateBundle: {
      // After StyleX added its rules to the stylesheet.
      order: "post",
      handler(_options, bundle) {
        if (!building) {
          return;
        }
        const html = bundle["index.html"];
        if (
          html?.type !== "asset" ||
          typeof html.source !== "string" ||
          !html.source.includes("</head>")
        ) {
          throw new Error("lean-parts: the build has no index.html");
        }
        const stylesheets = Object.values(bundle).filter(
          (output) =>
            output.type === "asset" && output.fileName.endsWith(".css")
        );
        const [whole] = stylesheets;
        if (
          stylesheets.length !== 1 ||
          whole?.type !== "asset" ||
          typeof whole.source !== "string"
        ) {
          throw new Error("lean-parts: the build has no one stylesheet");
        }
        used ??= usedTokens(this, tokens, routesDir);
        const lean = this.getFileName(
          this.emitFile({
            type: "asset",
            name: "lean.css",
            source: leanStylesheet(whole.source, used),
          })
        );
        const metas = [
          `<meta name="${leanStylesMeta}" content="${base}${lean}">`,
          `<meta name="${wholeStylesMeta}" content="${base}${whole.fileName}">`,
        ];
        html.source = html.source.replace(
          "</head>",
          `  ${metas.join("\n    ")}\n  </head>`
        );
      },
    },
  };

  return [unlinkStyles, parts];
};
