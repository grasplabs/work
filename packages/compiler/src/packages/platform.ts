/**
 * The packages the platform provides to App code itself, at the exact
 * versions this release's kit is built with (build.ts): an App's packages
 * share them, never bring their own. A package asking for another version
 * is refused, not given a second React.
 */
import reactDomManifest from "react-dom/package.json" with { type: "json" };
import reactManifest from "react/package.json" with { type: "json" };

export const platformPeers: Readonly<Record<string, string>> = {
  react: reactManifest.version,
  "react-dom": reactDomManifest.version,
};

/**
 * The modules of React and React DOM the kit provides, by specifier: all
 * an App's code and packages may import of them.
 */
export const platformModules = [
  "react",
  "react/jsx-runtime",
  "react/compiler-runtime",
  "react-dom",
  "react-dom/client",
];

/**
 * The platform's own scope: its SDK and UI kit are never npm packages.
 * One by that name on the registry is someone else's, and refused.
 */
export const platformScope = "@grasp-os/";
