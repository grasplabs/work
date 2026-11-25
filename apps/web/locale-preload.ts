import type { Plugin } from "vite-plus";

import {
  isLeanPath,
  leanPaths,
  leanStylesMeta,
  wholeStylesMeta,
} from "./src/lean-pages.ts";
import { localeCookie, pickLocale } from "./src/locale-choice.ts";

// A language's catalog (src/locales/<locale>/messages.po) is a chunk of its
// own, imported once main.tsx runs (src/i18n.ts): a second round trip
// before the first page can say anything. This adds a small script to
// index.html that preloads the catalog of the language the page will
// choose, so it comes alongside the app's own code: on a lean page
// (src/lean-pages.ts) its lean part, elsewhere the whole. So too the
// stylesheet, which the app links and waits for itself (src/page-parts.ts).
//
// A file under `/assets/`, not inline: the CSP allows no inline script
// (core's src/security-headers.ts). `async`, so it never holds up the page.

const catalogPath =
  /^(?<lean>\0lean-catalog:)?.*\/locales\/(?<locale>[^/]+)\/messages\.po(?:\.lean)?$/u;

/** A language's catalog files: its lean part and the whole. */
export interface CatalogFiles {
  lean: string;
  whole: string;
}

/** The stylesheet's files: its lean copy and the whole (lean-parts.ts). */
export interface StyleFiles {
  lean: string;
  whole: string;
}

/**
 * The script, given each language's catalog files and the stylesheet's:
 * it chooses the language as src/i18n.ts does, with the same function
 * (src/locale-choice.ts), from the cookie the choice is kept in and the
 * browser's languages, and the part as src/main.tsx does, from the page's
 * path, with the same function (src/lean-pages.ts).
 */
export const preloadScript = (
  catalogs: Record<string, CatalogFiles>,
  styles: StyleFiles
): string => `{
  const catalogs = ${JSON.stringify(catalogs)};
  const pickLocale = ${pickLocale.toString()};
  const isLeanPath = ${isLeanPath.toString()};
  const lean = isLeanPath(location.pathname, ${JSON.stringify(leanPaths)});
  const chosen = document.cookie
    .split("; ")
    .find((pair) => pair.startsWith("${localeCookie}="))
    ?.slice(${localeCookie.length + 1});
  const locale = pickLocale(chosen, navigator.languages, Object.keys(catalogs));
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.crossOrigin = "";
  link.href = catalogs[locale][lean ? "lean" : "whole"];
  document.head.append(link);
  const styles = ${JSON.stringify(styles)};
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet";
  sheet.crossOrigin = "";
  sheet.href = styles[lean ? "lean" : "whole"];
  document.head.append(sheet);
}
`;

export const localePreload = (): Plugin => {
  let base = "/";
  return {
    name: "grasp:locale-preload",
    apply: "build",
    configResolved: (config) => {
      ({ base } = config);
    },
    generateBundle: {
      // After Vite wrote index.html, which this adds the script to.
      order: "post",
      handler(_options, bundle) {
        const files: Record<string, Partial<CatalogFiles>> = {};
        for (const output of Object.values(bundle)) {
          const groups =
            output.type === "chunk"
              ? output.facadeModuleId?.match(catalogPath)?.groups
              : undefined;
          if (groups?.locale !== undefined) {
            files[groups.locale] = {
              ...files[groups.locale],
              [groups.lean === undefined ? "whole" : "lean"]:
                `${base}${output.fileName}`,
            };
          }
        }
        const catalogs: Record<string, CatalogFiles> = {};
        for (const [locale, { lean, whole }] of Object.entries(files)) {
          if (lean === undefined || whole === undefined) {
            throw new Error(
              `locale-preload: the build has no lean and whole ${locale} catalog`
            );
          }
          catalogs[locale] = { lean, whole };
        }
        const html = bundle["index.html"];
        if (
          html?.type !== "asset" ||
          typeof html.source !== "string" ||
          !html.source.includes("</head>")
        ) {
          throw new Error("locale-preload: the build has no index.html");
        }
        if (catalogs.en === undefined) {
          throw new Error("locale-preload: the build has no English catalog");
        }
        const { source } = html;
        const named = (meta: string): string => {
          const href = new RegExp(
            `<meta name="${meta}" content="(?<href>[^"]+)">`,
            "u"
          ).exec(source)?.groups?.href;
          if (href === undefined) {
            throw new Error(`locale-preload: index.html names no ${meta}`);
          }
          return href;
        };
        const styles = {
          lean: named(leanStylesMeta),
          whole: named(wholeStylesMeta),
        };
        const script = this.getFileName(
          this.emitFile({
            type: "asset",
            name: "locale-preload.js",
            source: preloadScript(catalogs, styles),
          })
        );
        const tag = `<script async src="${base}${script}"></script>`;
        html.source = html.source.replace("</head>", `  ${tag}\n  </head>`);
      },
    },
  };
};
