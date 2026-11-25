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

import { isLeanPage, leanPages, stylesMeta } from "./src/lean-pages.ts";
import type { LeanPage } from "./src/lean-pages.ts";

// Each lean page (src/lean-pages.ts) loads its own part of the app's
// stylesheet and of its language's catalog: what the modules it can run
// use, worked out here from the build's own module graph. Every other page
// loads the whole, as before (src/page-parts.ts).
//
// A module a page "can run" is the app's entry (main.tsx), the route tree
// it loads for the page, the page's route, or any module those import,
// statically or not, but never another route's page, another route tree
// main.tsx loads, or a catalog. Whatever else that takes in (the app's
// route tree imports much of the app) only makes a part bigger, never
// short.
//
// - A catalog imported as `messages.po?lean=<page>` keeps only the
//   messages whose ids those modules hold. It is filled in as its chunk is
//   written, before the chunk's name is hashed, so the name changes with
//   what it holds.
// - The page's copy of the stylesheet drops the rules made for class names
//   no such module holds: StyleX's atomic rules and Tailwind's utilities,
//   never a rule written by hand. Its rules keep their order, so with the
//   whole stylesheet loaded after it every rule still wins as in the whole
//   alone. index.html links no stylesheet: it names each in a meta tag,
//   for the app to load the one the page needs (src/page-parts.ts) and the
//   preload script to fetch it early (locale-preload.ts).
//
// Out of a build (the dev server, tests) a lean catalog is the whole
// catalog and the stylesheet stays whole: everything is there to look up.

const leanQuery = /\.po\?lean=(?<page>\w+)$/u;
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

/** The build's module graph, as far as a page's modules need. */
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

const withoutQuery = (id: string): string => id.split("?")[0] ?? id;
const isRouteSplit = (id: string): boolean => id.includes("?tsr-split");
const isCatalog = (id: string): boolean =>
  id.startsWith(leanCatalogId) || withoutQuery(id).endsWith(".po");

/** The modules the lean `page` can run (above), from the build's graph. */
export const leanModules = (
  graph: Graph,
  srcDir: string,
  page: LeanPage
): Set<string> => {
  const { route, routes } = leanPages[page];
  const ownRoute = path.join(srcDir, "routes", route);
  const ownRoutes = path.join(srcDir, routes);
  const routeTrees = new Set(
    Object.values(leanPages).map((each) => path.join(srcDir, each.routes))
  );
  const roots = [...graph.ids()].filter(
    (id) =>
      graph.info(id)?.isEntry === true ||
      id === ownRoutes ||
      (isRouteSplit(id) && withoutQuery(id) === ownRoute)
  );
  const seen = new Set<string>();
  const next = [...roots];
  for (let id = next.pop(); id !== undefined; id = next.pop()) {
    const info = seen.has(id) ? undefined : graph.info(id);
    seen.add(id);
    if (info) {
      next.push(
        ...info.importedIds,
        // main.tsx loads one route tree (a root already) of those it
        // may load, by the page.
        ...info.dynamicallyImportedIds.filter(
          (each) =>
            !isCatalog(each) &&
            !routeTrees.has(each) &&
            !(isRouteSplit(each) && withoutQuery(each) !== ownRoute)
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

/** Every token the modules the lean `page` can run hold. */
const usedTokens = (
  context: {
    getModuleIds: () => IterableIterator<string>;
    getModuleInfo: Graph["info"];
  },
  tokens: ReadonlyMap<string, ReadonlySet<string>>,
  srcDir: string,
  page: LeanPage
): Set<string> => {
  const used = new Set<string>();
  const modules = leanModules(
    {
      ids: () => context.getModuleIds(),
      info: (id) => context.getModuleInfo(id),
    },
    srcDir,
    page
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
  let srcDir = "";
  /** Each module's tokens: what its code may name a class or message by. */
  const tokens = new Map<string, Set<string>>();
  /** Each lean catalog's placeholder, and the catalog it stands for. */
  const catalogs = new Map<
    string,
    { page: LeanPage; locale: string; messages: Record<string, string> }
  >();
  /** Each lean page's tokens, once worked out. */
  const used = new Map<LeanPage, Set<string>>();
  const usedBy = (
    context: Parameters<typeof usedTokens>[0],
    page: LeanPage
  ): Set<string> => {
    const found = used.get(page) ?? usedTokens(context, tokens, srcDir, page);
    used.set(page, found);
    return found;
  };

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
      srcDir = path.join(config.root, "src");
    },
    buildStart: () => {
      tokens.clear();
      catalogs.clear();
      used.clear();
    },
    resolveId: {
      order: "pre",
      handler(source, importer) {
        const page = leanQuery.exec(source)?.groups?.page;
        if (page === undefined || importer === undefined) {
          return null;
        }
        if (!isLeanPage(page)) {
          throw new Error(`lean-parts: ${page} is no lean page`);
        }
        const file = path.resolve(path.dirname(importer), withoutQuery(source));
        return building
          ? `${leanCatalogId}${page}:${file}${leanCatalogEnd}`
          : file;
      },
    },
    async load(id) {
      if (!id.startsWith(leanCatalogId)) {
        return null;
      }
      const [page = "", file = ""] = id
        .slice(leanCatalogId.length, -leanCatalogEnd.length)
        .split(/:(?<file>.*)/u);
      if (!isLeanPage(page)) {
        throw new Error(`lean-parts: ${page} is no lean page`);
      }
      this.addWatchFile(file);
      const { locale, messages } = await translations(linguiConfig, file);
      // A name the chunk keeps as it is, for the lean messages to replace.
      const placeholder = `__grasp_lean_catalog_${page}_${locale.replaceAll(/\W/gu, "_")}__`;
      catalogs.set(placeholder, { page, locale, messages });
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
      let filled = code;
      for (const [placeholder, { page, locale, messages }] of catalogs) {
        if (filled.includes(placeholder)) {
          const pageUses = usedBy(this, page);
          const lean = Object.fromEntries(
            Object.entries(messages).filter(([id]) => pageUses.has(id))
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
            throw new Error(
              `lean-parts: Lingui compiled ${locale} as no catalog`
            );
          }
          if (errors.length > 0) {
            this.warn(
              `lean-parts: ${errors.length} messages of ${locale} don't compile`
            );
          }
          filled = filled.replace(
            placeholder,
            JSON.stringify(JSON.stringify(parsed.messages))
          );
        }
      }
      return filled === code ? null : { code: filled, map: null };
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
        const metas = [
          `<meta name="${stylesMeta("whole")}" content="${base}${whole.fileName}">`,
        ];
        for (const page of Object.keys(leanPages).filter(isLeanPage)) {
          const file = this.getFileName(
            this.emitFile({
              type: "asset",
              name: `${page}.css`,
              source: leanStylesheet(whole.source, usedBy(this, page)),
            })
          );
          metas.push(
            `<meta name="${stylesMeta(page)}" content="${base}${file}">`
          );
        }
        html.source = html.source.replace(
          "</head>",
          `  ${metas.join("\n    ")}\n  </head>`
        );
      },
    },
  };

  return [unlinkStyles, parts];
};
