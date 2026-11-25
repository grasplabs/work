import type { Plugin } from "vite-plus";

import {
  isLeanPage,
  leanPageAt,
  leanPages,
  leanPaths,
  stylesMeta,
} from "./src/lean-pages.ts";
import type { Part } from "./src/lean-pages.ts";
import { localeCookie, pickLocale } from "./src/locale-choice.ts";

// A language's catalog (src/locales/<locale>/messages.po) is a chunk of its
// own, imported once main.tsx runs (src/i18n.ts): a second round trip
// before the first page can say anything. This adds a small script to
// index.html that preloads the catalog of the language the page will
// choose, so it comes alongside the app's own code: on a lean page
// (src/lean-pages.ts) that page's part, elsewhere the whole. So too the
// stylesheet, which the app links and waits for itself (src/page-parts.ts).
//
// A file under `/assets/`, not inline: the CSP allows no inline script
// (core's src/security-headers.ts). `async`, so it never holds up the page.

const catalogPath =
  /^(?:\0lean-catalog:(?<page>\w+):)?.*\/locales\/(?<locale>[^/]+)\/messages\.po(?:\.lean)?$/u;

/** A file of each part: each lean page's, and the whole. */
export type PartFiles = Record<Part, string>;

/**
 * The script, given each language's catalog files and the stylesheet's:
 * it chooses the language as src/i18n.ts does, with the same function
 * (src/locale-choice.ts), from the cookie the choice is kept in and the
 * browser's languages, and the part as src/main.tsx does, from the page's
 * path, with the same function (src/lean-pages.ts).
 */
export const preloadScript = (
  catalogs: Record<string, PartFiles>,
  styles: PartFiles
): string => `{
  const catalogs = ${JSON.stringify(catalogs)};
  const pickLocale = ${pickLocale.toString()};
  const leanPageAt = ${leanPageAt.toString()};
  const part =
    leanPageAt(location.pathname, ${JSON.stringify(leanPaths)}) ?? "whole";
  const chosen = document.cookie
    .split("; ")
    .find((pair) => pair.startsWith("${localeCookie}="))
    ?.slice(${localeCookie.length + 1});
  const locale = pickLocale(chosen, navigator.languages, Object.keys(catalogs));
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.crossOrigin = "";
  link.href = catalogs[locale][part];
  document.head.append(link);
  const styles = ${JSON.stringify(styles)};
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet";
  sheet.crossOrigin = "";
  sheet.href = styles[part];
  document.head.append(sheet);
}
`;

const parts: readonly Part[] = [
  ...Object.keys(leanPages).filter(isLeanPage),
  "whole",
];

/** `found`, when it has a file of every part. */
const allParts = (found: Partial<PartFiles>, what: string): PartFiles => {
  const { interview, setup, whole } = found;
  if (interview === undefined || setup === undefined || whole === undefined) {
    throw new Error(`locale-preload: the build lacks a part of the ${what}`);
  }
  return { interview, setup, whole };
};

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
        const files: Record<string, Partial<PartFiles>> = {};
        for (const output of Object.values(bundle)) {
          const groups =
            output.type === "chunk"
              ? output.facadeModuleId?.match(catalogPath)?.groups
              : undefined;
          if (groups?.locale !== undefined) {
            files[groups.locale] = {
              ...files[groups.locale],
              [groups.page ?? "whole"]: `${base}${output.fileName}`,
            };
          }
        }
        const catalogs: Record<string, PartFiles> = {};
        for (const [locale, found] of Object.entries(files)) {
          catalogs[locale] = allParts(found, `${locale} catalog`);
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
        const styles = allParts(
          Object.fromEntries(
            parts.map((part) => [part, named(stylesMeta(part))])
          ),
          "stylesheet"
        );
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
