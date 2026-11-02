import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import { preloadScript } from "./locale-preload.ts";
import { pickLocale } from "./src/locale-choice.ts";

// The script index.html runs before the app preloads the catalog of the
// language the app then chooses (src/i18n.ts): run in a page of its own,
// it asks for the file of the language `pickLocale` picks from the same
// cookie and browser languages, and English's when nothing fits.

const catalogs = {
  en: "/assets/messages-en.js",
  de: "/assets/messages-de.js",
  nl: "/assets/messages-nl.js",
};

/** What the script preloads in a page with `cookie` and `languages`. */
const preloaded = (cookie: string, languages: string[]): unknown => {
  const head: { href?: unknown; rel?: unknown }[] = [];
  runInNewContext(preloadScript(catalogs), {
    document: {
      cookie,
      createElement: () => ({}),
      head: {
        append: (link: { href?: unknown; rel?: unknown }) => {
          head.push(link);
        },
      },
    },
    navigator: { languages },
  });
  expect(head.map(({ rel }) => rel)).toStrictEqual(["modulepreload"]);
  return head[0]?.href;
};

/** A page: its cookies, the browser's languages, and what it speaks. */
interface Visit {
  cookie: string;
  /** The choice the cookie keeps, as the app reads it. */
  chosen: string | undefined;
  languages: string[];
  speaks: keyof typeof catalogs;
}

const visits: Visit[] = [
  {
    cookie: "grasp-locale=nl",
    chosen: "nl",
    languages: ["de-DE"],
    speaks: "nl",
  },
  {
    cookie: "theme=dark; grasp-locale=de; other=1",
    chosen: "de",
    languages: ["nl"],
    speaks: "de",
  },
  {
    cookie: "grasp-locale=xx",
    chosen: "xx",
    languages: ["fr", "de-AT"],
    speaks: "de",
  },
  { cookie: "", chosen: undefined, languages: ["DE-ch", "nl"], speaks: "de" },
  { cookie: "", chosen: undefined, languages: ["fr", "it"], speaks: "en" },
  { cookie: "", chosen: undefined, languages: [], speaks: "en" },
];

describe("the catalog preload", () => {
  it.each(visits)(
    "preloads the catalog the app picks, $speaks, for $cookie and $languages",
    ({ cookie, chosen, languages, speaks }) => {
      const picked = pickLocale(chosen, languages, Object.keys(catalogs));

      expect({ picked, preloaded: preloaded(cookie, languages) }).toStrictEqual(
        {
          picked: speaks,
          preloaded: catalogs[speaks],
        }
      );
    }
  );
});
