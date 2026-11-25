/**
 * The pages that load only what they use: someone's interview and the
 * company's setup, the first pages of Grasp most people ever open. The
 * app's stylesheet and each language's catalog are a lean part, for these
 * pages, and the whole, for every other: the build (lean-pages.ts beside
 * vite.config.ts) works out the lean part from what these routes import,
 * and the app loads the whole as it goes anywhere else (page-parts.ts).
 *
 * `route` is the page's file in `routes/`, as the build finds it.
 */
export const leanPages = [
  { path: "/interview", route: "interview.tsx" },
  { path: "/setup", route: "setup.tsx" },
] as const;

export const leanPaths: readonly string[] = leanPages.map(({ path }) => path);

/**
 * Whether `pathname` is one of the lean `paths`, or under one. It uses
 * nothing but its arguments: lean-pages.ts writes its source into the
 * script that preloads the page's catalog and stylesheet before the app
 * runs, so both decide alike.
 */
export const isLeanPath = (
  pathname: string,
  paths: readonly string[]
): boolean => {
  // The router matches addresses whatever their case and with a trailing
  // slash (boot-path.ts), so this does too.
  const address = pathname.toLowerCase().replace(/\/+$/u, "");
  return paths.some(
    (path) => address === path || address.startsWith(`${path}/`)
  );
};

/**
 * The meta tags in which a build's index.html names the stylesheet's lean
 * copy and the whole. The dev server's has neither: it links every style.
 */
export const leanStylesMeta = "grasp:lean-styles";
export const wholeStylesMeta = "grasp:whole-styles";
