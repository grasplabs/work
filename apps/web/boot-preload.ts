import type { Plugin } from "vite-plus";

import { bootOf } from "./src/boot-path.ts";

// The page's routes (src/app-routes.tsx, or src/interview-routes.tsx at an
// interview link) are chunks of their own, imported once main.tsx runs
// (src/boot-path.ts): without help, a second round trip before the page
// can show anything. This adds a small script to index.html that
// preloads the routes the page will load, with every file they import,
// so they come alongside main.tsx's own code.
//
// A file under `/assets/`, not inline: the CSP allows no inline script
// (core's src/security-headers.ts). `async`, so it never holds up the page.

/** Each way in, by its source file. */
const routesFile = {
  app: /\/src\/app-routes\.tsx$/u,
  interview: /\/src\/interview-routes\.tsx$/u,
} as const;

type Boot = keyof typeof routesFile;

/**
 * The script, given the files each way in needs: it chooses the way in as
 * main.tsx does, with the same function (src/boot-path.ts), from the
 * page's address.
 */
export const preloadScript = (files: Record<Boot, string[]>): string => `{
  const files = ${JSON.stringify(files)};
  const bootOf = ${bootOf.toString()};
  for (const href of files[bootOf(location.pathname)]) {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.crossOrigin = "";
    link.href = href;
    document.head.append(link);
  }
}
`;

/** A chunk of the build: its file, and the chunks it imports statically. */
interface Chunk {
  fileName: string;
  imports: string[];
}

/** `start`, and every chunk it imports, however deep, as built paths. */
export const importedFrom = (
  start: Chunk,
  chunks: ReadonlyMap<string, Chunk>,
  base: string
): string[] => {
  const seen = new Set<string>();
  const next = [start.fileName];
  while (next.length > 0) {
    const fileName = next.pop();
    if (fileName !== undefined && !seen.has(fileName)) {
      seen.add(fileName);
      next.push(...(chunks.get(fileName)?.imports ?? []));
    }
  }
  return [...seen].map((fileName) => `${base}${fileName}`);
};

export const bootPreload = (): Plugin => {
  let base = "/";
  return {
    name: "grasp:boot-preload",
    apply: "build",
    configResolved: (config) => {
      ({ base } = config);
    },
    generateBundle: {
      // After Vite wrote index.html, which this adds the script to.
      order: "post",
      handler(_options, bundle) {
        const chunks = new Map<string, Chunk>();
        const starts: Partial<Record<Boot, Chunk>> = {};
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk") {
            chunks.set(output.fileName, output);
            for (const boot of ["app", "interview"] as const) {
              if (routesFile[boot].test(output.facadeModuleId ?? "")) {
                starts[boot] = output;
              }
            }
          }
        }
        const html = bundle["index.html"];
        if (
          html?.type !== "asset" ||
          typeof html.source !== "string" ||
          !html.source.includes("</head>")
        ) {
          throw new Error("boot-preload: the build has no index.html");
        }
        if (starts.app === undefined || starts.interview === undefined) {
          throw new Error("boot-preload: the build has no routes to preload");
        }
        const script = this.getFileName(
          this.emitFile({
            type: "asset",
            name: "boot-preload.js",
            source: preloadScript({
              app: importedFrom(starts.app, chunks, base),
              interview: importedFrom(starts.interview, chunks, base),
            }),
          })
        );
        const tag = `<script async src="${base}${script}"></script>`;
        html.source = html.source.replace("</head>", `  ${tag}\n  </head>`);
      },
    },
  };
};
