import { routerSecretHeader } from "@grasp-os/shared/router";
import { screenFramePath } from "@grasp-os/shared/screens";
import { env, exports } from "cloudflare:workers";

// What a browser loads for a screen's frame, through core's own routes:
// the frame's document for a build, its policy, and each module it names.

/** A request to core as the router sends it, for `path`. */
export const routed = async (path: string): Promise<Response> =>
  await exports.default.fetch(`https://core${path}`, {
    headers: { [routerSecretHeader]: env.ROUTER_SECRET },
  });

const whitespace = /\s+/u;

/**
 * The directives of a response's Content Security Policy, by name. As in
 * browsers, the first of a repeated directive counts.
 */
export const policyOf = (response: Response): Map<string, string[]> => {
  const header = response.headers.get("content-security-policy") ?? "";
  const directives = new Map<string, string[]>();
  for (const directive of header.split(";")) {
    const [name = "", ...sources] = directive.trim().split(whitespace);
    const key = name.toLowerCase();
    if (key !== "" && !directives.has(key)) {
      directives.set(key, sources);
    }
  }
  return directives;
};

const importMapPattern = /<script type="importmap">(?<json>.*?)<\/script>/su;
const screenPattern =
  /<script type="application\/json" id="screen">(?<json>.*?)<\/script>/su;
const inlineScriptPattern =
  /<script(?<attributes>[^>]*)>(?<text>.*?)<\/script>/gsu;

/** A CSP hash source for an inline script with exactly `text`. */
const hashSource = async (text: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  );
  return `'sha256-${btoa(String.fromCodePoint(...digest))}'`;
};

/** A frame's document, read as a browser reads it, and what it loads. */
export interface LoadedFrame {
  status: number;
  /** The frame's policy, by directive. */
  policy: Map<string, string[]>;
  /** What the document says it runs. */
  screen: { artifact: string; entry: string; runtime: string; css: string };
  /** Each module the import map names, by name, with the code its address serves. */
  modules: Record<string, string>;
  /** The import map's addresses, by name. */
  addresses: Record<string, string>;
  /** The hash sources of the scripts a browser would run inline in it. */
  inline: string[];
}

const jsonIn = (pattern: RegExp, html: string): unknown =>
  JSON.parse(pattern.exec(html)?.groups?.json ?? "null");

/** What a page frames a build with: its hash, and core's token for it. */
export interface Framed {
  artifact: string;
  frameToken: string;
}

/** The frame's document for a build, as the page frames it. */
export const frameDocument = async ({
  artifact,
  frameToken,
}: Framed): Promise<Response> => {
  const query = new URLSearchParams({
    load: "test",
    artifact,
    token: frameToken,
  }).toString();
  return await routed(`${screenFramePath}?${query}`);
};

/** A path and query of an absolute address, as core is asked for it. */
export const pathOf = (address: string): string => {
  const { pathname, search } = new URL(address);
  return `${pathname}${search}`;
};

/**
 * The frame core serves for a build, with every module it names fetched
 * from its address: what a browser's frame runs. Null when core serves no
 * screen for it.
 */
export const loadFrame = async (
  framed: Framed
): Promise<LoadedFrame | null> => {
  const response = await frameDocument(framed);
  if (response.status !== 200) {
    return null;
  }
  const html = await response.text();
  // SAFETY: core's own document, which writes these shapes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const { imports } = jsonIn(importMapPattern, html) as {
    imports: Record<string, string>;
  };
  // SAFETY: as above, core's own document.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const screen = jsonIn(screenPattern, html) as LoadedFrame["screen"];
  const modules = Object.fromEntries(
    await Promise.all(
      Object.entries(imports).map(async ([name, address]) => {
        const served = await routed(pathOf(address));
        return [name, await served.text()] as const;
      })
    )
  );
  const inline = await Promise.all(
    [...html.matchAll(inlineScriptPattern)]
      // A data block is not run, so no policy governs it.
      .filter(
        ({ groups }) =>
          groups?.attributes?.includes("application/json") !== true
      )
      .map(async ({ groups }) => await hashSource(groups?.text ?? ""))
  );
  return {
    status: response.status,
    policy: policyOf(response),
    screen,
    modules,
    addresses: imports,
    inline,
  };
};

/** The App's own modules of a frame: the rest are the kit's. */
export const appModulesOf = ({
  modules,
}: Pick<LoadedFrame, "modules">): string[] =>
  Object.keys(modules).filter((name) => name.startsWith("app~"));

/** The kit's modules of a frame, with their code. */
export const kitModulesOf = ({
  modules,
}: LoadedFrame): Record<string, string> =>
  Object.fromEntries(
    Object.entries(modules).filter(([name]) => !name.startsWith("app~"))
  );
