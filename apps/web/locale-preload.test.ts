import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import { preloadScript } from "./locale-preload.ts";
import { pickLocale } from "./src/locale-choice.ts";

// The script index.html runs before the app preloads the catalog of the
// language the app then chooses (src/i18n.ts): run in a page of its own,
// it asks for the file of the language `pickLocale` picks from the same
// cookie and browser languages, and English's when nothing fits. On a lean
// page (src/lean-pages.ts) it asks for that page's part of the catalog and
// of the stylesheet, as the app then loads them; elsewhere for the whole.

const partsOf = (locale: string) => ({
  interview: `/assets/interview-${locale}.js`,
  setup: `/assets/setup-${locale}.js`,
  whole: `/assets/messages-${locale}.js`,
});

const catalogs = { en: partsOf("en"), de: partsOf("de"), nl: partsOf("nl") };

const styles = {
  interview: "/assets/interview.css",
  setup: "/assets/setup.css",
  whole: "/assets/index.css",
};

/** What the script links in a page at `pathname`. */
const linked = (
  cookie: string,
  languages: string[],
  pathname = "/"
): unknown[] => {
  const head: { href?: unknown; rel?: unknown }[] = [];
  runInNewContext(preloadScript(catalogs, styles), {
    document: {
      cookie,
      createElement: () => ({}),
      head: {
        append: (link: { href?: unknown; rel?: unknown }) => {
          head.push(link);
        },
      },
    },
    location: { pathname },
    navigator: { languages },
  });
  return head.map(({ rel, href }) => [rel, href]);
};

/** What the script preloads in a page with `cookie` and `languages`. */
const preloaded = (cookie: string, languages: string[]): unknown => {
  const [catalog, ...rest] = linked(cookie, languages);
  expect(rest).toStrictEqual([["stylesheet", styles.whole]]);
  return Array.isArray(catalog) && catalog[0] === "modulepreload"
    ? catalog[1]
    : undefined;
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
          preloaded: catalogs[speaks].whole,
        }
      );
    }
  );
});

describe("the lean pages' preload", () => {
  it.each([
    ["/interview", "interview"],
    ["/interview/", "interview"],
    ["/setup", "setup"],
    ["/Setup/", "setup"],
  ] as const)(
    "links the page's own part of the catalog and stylesheet on %s",
    (pathname, page) => {
      expect(linked("grasp-locale=de", [], pathname)).toStrictEqual([
        ["modulepreload", catalogs.de[page]],
        ["stylesheet", styles[page]],
      ]);
    }
  );

  it.each(["/", "/inbox", "/interviews", "/setup-later"])(
    "links the whole of both on %s",
    (pathname) => {
      expect(linked("grasp-locale=de", [], pathname)).toStrictEqual([
        ["modulepreload", catalogs.de.whole],
        ["stylesheet", styles.whole],
      ]);
    }
  );
});
