import type { Plugin } from "vite-plus";

import { localeCookie, pickLocale } from "./src/locale-choice.ts";

// A language's catalog (src/locales/<locale>/messages.po) is a chunk of its
// own, imported once main.tsx runs (src/i18n.ts): a second round trip
// before the first page can say anything. This adds a small script to
// index.html that preloads the catalog of the language the page will
// choose, so it comes alongside the app's own code.
//
// A file under `/assets/`, not inline: the CSP allows no inline script
// (core's src/security-headers.ts). `async`, so it never holds up the page.

const catalogPath = /\/locales\/(?<locale>[^/]+)\/messages\.po$/u;

/**
 * The script, given each language's catalog file: it chooses the language
 * as src/i18n.ts does, with the same function (src/locale-choice.ts),
 * from the cookie the choice is kept in and the browser's languages.
 */
export const preloadScript = (catalogs: Record<string, string>): string => `{
  const catalogs = ${JSON.stringify(catalogs)};
  const pickLocale = ${pickLocale.toString()};
  const chosen = document.cookie
    .split("; ")
    .find((pair) => pair.startsWith("${localeCookie}="))
    ?.slice(${localeCookie.length + 1});
  const locale = pickLocale(chosen, navigator.languages, Object.keys(catalogs));
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.crossOrigin = "";
  link.href = catalogs[locale];
  document.head.append(link);
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
        const catalogs: Record<string, string> = {};
        for (const output of Object.values(bundle)) {
          const locale =
            output.type === "chunk"
              ? output.facadeModuleId?.match(catalogPath)?.groups?.locale
              : undefined;
          if (locale !== undefined) {
            catalogs[locale] = `${base}${output.fileName}`;
          }
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
        const script = this.getFileName(
          this.emitFile({
            type: "asset",
            name: "locale-preload.js",
            source: preloadScript(catalogs),
          })
        );
        const tag = `<script async src="${base}${script}"></script>`;
        html.source = html.source.replace("</head>", `  ${tag}\n  </head>`);
      },
    },
  };
};
