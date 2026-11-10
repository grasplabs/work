/**
 * Builds the SDK docs: the API reference from the SDK's types and doc
 * comments (TypeDoc), then the site (Blume), static, for `/docs`, with
 * the hashes of its pages' inline code, which core's policy for them
 * allows (`inlineHashesFile`).
 *
 * The reference is generated on every build into `content/reference/`,
 * which git ignores: it is build output, like the frontend's `dist/`, so
 * it can never drift from the SDK it was built from, and CI's release
 * build makes it with every pull request.
 *
 * Usage: node build.ts [<dir>]: with a directory, the site is copied
 * there too; core's build passes `../web/dist/docs`, so the frontend's
 * static files carry it and core serves it at `/docs` (src/docs.ts).
 * Core's build is the one place the docs are built: they have no `build`
 * script, so `vp run -r build` builds them once.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { defaultTreeAdapter, parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";

import { writeExamples } from "./example-apps.ts";
import { writeReference } from "./reference.ts";
import type { ReferenceOptions } from "./reference.ts";

const root = import.meta.dirname;
const sdk = path.join(root, "../../packages/sdk");
const reference = path.join(root, "content/reference");
const site = path.join(root, "dist");

/** Where the site's inline hashes are, as core reads them (src/docs.ts). */
const inlineHashesFile = "inline-hashes.json";

/**
 * The SDK's modules App code imports, one reference page each: the root
 * (values, schemas, `defineApp`, permissions), what server functions get
 * (`@server/_generated/server` re-exports its types) with the database, the
 * Pages' hooks, and what an App's tests run on.
 */
const modules: Readonly<Record<string, string>> = {
  index: "@grasp-os/sdk",
  server: "@grasp-os/sdk/server",
  react: "@grasp-os/sdk/react",
  testing: "@grasp-os/sdk/testing",
};

/** A module's page, by its file: the root's is `sdk`, beside the index. */
const pageOf = (file: string): string => (file === "index" ? "sdk" : file);

/**
 * The reference's options. A broken `{@link}` or a doc comment TypeDoc
 * can't read fails the build, as a type error would (reference.ts).
 */
const referenceOptions: ReferenceOptions = {
  entryPoints: Object.keys(modules).map((file) =>
    path.join(sdk, "src", `${file}.ts`)
  ),
  tsconfig: path.join(sdk, "tsconfig.json"),
  out: reference,
  readme: "none",
  router: "module",
  entryFileName: "index",
  // Each page is titled by the specifier App code imports it by.
  pageTitleTemplates: {
    index: "API reference",
    module: ({ rawName }) =>
      Object.entries(modules).find(([file]) => pageOf(file) === rawName)?.[1] ??
      rawName,
  },
  parametersFormat: "table",
  interfacePropertiesFormat: "table",
  classPropertiesFormat: "table",
  typeAliasPropertiesFormat: "table",
  typeDeclarationFormat: "table",
  enumMembersFormat: "table",
  // The SDK's types are checked by the repo's own type check (tsgo);
  // TypeDoc's TypeScript only reads them.
  skipErrorChecking: true,
  // Where each member is declared is the SDK's business, not the
  // reader's: the reference names modules by what App code imports.
  disableSources: true,
  excludeExternals: true,
  excludePrivate: true,
  excludeInternal: true,
  hideBreadcrumbs: true,
  hidePageHeader: true,
};

const buildReference = async (): Promise<void> => {
  rmSync(reference, { force: true, recursive: true });
  await writeReference(referenceOptions, pageOf);
};

/** `text`'s hash as a policy names it: `'sha256-<base64>'`. */
const hashOf = (text: string): string =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** The inline code of the site's pages, by kind. */
interface InlineCode {
  scripts: Set<string>;
  styles: Set<string>;
  styleAttributes: Set<string>;
}

type Node = DefaultTreeAdapterTypes.Node;

/** The nodes under `node`, a template's content among them. */
const childrenOf = (node: Node): Node[] => {
  if (!("childNodes" in node)) {
    return [];
  }
  return "content" in node
    ? [...node.childNodes, node.content]
    : node.childNodes;
};

const textOf = (element: DefaultTreeAdapterTypes.Element): string =>
  element.childNodes
    .map((child) => (defaultTreeAdapter.isTextNode(child) ? child.value : ""))
    .join("");

const collect = (node: Node, code: InlineCode): void => {
  if (defaultTreeAdapter.isElementNode(node)) {
    const attribute = (name: string): string | undefined =>
      node.attrs.find((attr) => attr.name === name)?.value;
    const style = attribute("style");
    if (style !== undefined) {
      code.styleAttributes.add(hashOf(style));
    }
    if (node.tagName === "script" && attribute("src") === undefined) {
      code.scripts.add(hashOf(textOf(node)));
    }
    if (node.tagName === "style") {
      code.styles.add(hashOf(textOf(node)));
    }
  }
  for (const child of childrenOf(node)) {
    collect(child, code);
  }
};

/**
 * Writes the hashes of every page's inline scripts, styles and `style`
 * attributes, read with an HTML parser as a browser reads them. One set
 * for the whole site: its pages move to each other without a load
 * (Astro's client router), under the policy of the page first loaded.
 */
const writeInlineHashes = (): void => {
  const code: InlineCode = {
    scripts: new Set(),
    styles: new Set(),
    styleAttributes: new Set(),
  };
  const pages = readdirSync(site, { recursive: true, encoding: "utf-8" });
  for (const page of pages.filter((file) => file.endsWith(".html"))) {
    collect(parse(readFileSync(path.join(site, page), "utf-8")), code);
  }
  writeFileSync(
    path.join(site, inlineHashesFile),
    JSON.stringify({
      scripts: [...code.scripts].toSorted(),
      styles: [...code.styles].toSorted(),
      styleAttributes: [...code.styleAttributes].toSorted(),
    })
  );
};

/**
 * Removes what Blume writes for hosts other than core and what nothing
 * links to: other hosts' header and routing files, each page's MDX source
 * beside its Markdown (the agent reads the `.md`), and the 404 page's
 * JSON and Markdown twins.
 */
const removeUnserved = (): void => {
  const files = readdirSync(site, { recursive: true, encoding: "utf-8" });
  const unserved = files.filter(
    (file) =>
      file.endsWith(".mdx") ||
      ["_headers", "vercel.json", "404.json", "404.md"].includes(file)
  );
  for (const file of unserved) {
    rmSync(path.join(site, file));
  }
};

/**
 * `env` without what Vite sets for the code it runs (a test that builds
 * the docs), which Blume's own Vite would take for its settings:
 * `BASE_URL` moves the site off /docs.
 */
const withoutViteVariables = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !/^(?:BASE_URL|MODE|DEV|PROD|SSR|VITE.*)$/u.test(name)
    )
  );

await buildReference();
writeExamples();
// From a fresh project: Blume keeps the one it generates (`.blume/`) to
// write only what changed, a speed-up for `blume dev`, never a release.
rmSync(path.join(root, ".blume"), { force: true, recursive: true });
execFileSync(path.join(root, "node_modules/.bin/blume"), ["build"], {
  cwd: root,
  stdio: "inherit",
  env: withoutViteVariables(process.env),
});
removeUnserved();
writeInlineHashes();

const [out] = process.argv.slice(2);
if (out !== undefined) {
  const target = path.resolve(out);
  rmSync(target, { force: true, recursive: true });
  cpSync(site, target, { recursive: true });
}
