/**
 * The pages that load only what they use: someone's interview and the
 * company's setup, the first pages of Grasp most people ever open. Each
 * has its own part of the app's stylesheet and of each language's
 * catalog: the build (lean-parts.ts beside vite.config.ts) works it out
 * from what the page can run, and the app loads the whole as it goes
 * anywhere else (page-parts.ts).
 *
 * `route` is the page's file in `routes/`, and `routes` the route tree
 * main.tsx loads for it (boot-path.ts), as the build finds them.
 */
export const leanPages = {
  interview: {
    path: "/interview",
    route: "interview.tsx",
    routes: "interview-routes.tsx",
  },
  setup: { path: "/setup", route: "setup.tsx", routes: "app-routes.tsx" },
} as const;

export type LeanPage = keyof typeof leanPages;

/** The part of the stylesheet and catalogs a page loads. */
export type Part = LeanPage | "whole";

export const isLeanPage = (value: string): value is LeanPage =>
  Object.hasOwn(leanPages, value);

/** Each lean page's path. */
export const leanPaths: Readonly<Record<LeanPage, string>> = {
  interview: leanPages.interview.path,
  setup: leanPages.setup.path,
};

/**
 * The lean page at `pathname`, of those at `paths`, if it is one. It uses
 * nothing but its arguments: locale-preload.ts writes its source into the
 * script that preloads the page's catalog and stylesheet before the app
 * runs, so both decide alike. The router matches addresses whatever their
 * case and with a trailing slash (boot-path.ts), so this does too.
 */
export const leanPageAt = (
  pathname: string,
  paths: Readonly<Record<string, string>>
): string | undefined => {
  const address = pathname.toLowerCase().replace(/\/+$/u, "");
  return Object.keys(paths).find((page) => {
    const path = paths[page];
    return (
      path !== undefined && (address === path || address.startsWith(`${path}/`))
    );
  });
};

/** The part the page at `pathname` loads. */
export const partAt = (pathname: string): Part => {
  const page = leanPageAt(pathname, leanPaths);
  return page !== undefined && isLeanPage(page) ? page : "whole";
};

/**
 * The meta tag in which a build's index.html names the stylesheet of
 * `part`. The dev server's names none: it links every style.
 */
export const stylesMeta = (part: Part): string => `grasp:styles:${part}`;
