import { env, exports } from "cloudflare:workers";

import { probeModule } from "../isolate-probe.ts";

// What builds*.test.ts share: core's env as on-prem, the pages they build
// and how long a build and an answer may take.

/** A Loader core never reaches on-prem: compiling here would hold core. */
export const noLoader: WorkerLoader = {
  get: () => {
    throw new Error("Core loaded the compiler itself.");
  },
  load: () => {
    throw new Error("Core loaded the compiler itself.");
  },
};

/** How long a build may take on the sandbox host here. */
export const DEADLINE_MS = 4000;

/** How long core may take to answer another request meanwhile. */
export const ANSWER_MS = 500;

/** Core's env as on-prem, its Loader one a build must never reach. */
export const onPrem = { ...env, LOADER: noLoader };

/** A page with this code before its component. */
export const page = (code: string): Record<string, string> => ({
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

${code}
function Desk() {
  return <p>desk</p>;
}
export const Route = createFileRoute("/")({ component: Desk });
`,
});

/**
 * Types each of which takes TypeScript's checker seconds to expand, a
 * union of 2^16 nested tuples, and none of which reuses another's work:
 * a few lines that hold the checker far past any deadline.
 */
export const recursiveTypes = `type Split<T, N extends unknown[]> = N extends [unknown, ...infer R] ? Split<[T, 0], R> | Split<[T, 1], R> : T;
type Sixteen = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
${Array.from(
  { length: 40 },
  (_, index) =>
    `export const held${index}: Split<"${index}", Sixteen> = ${index};`
).join("\n")}`;

/** How long core takes to answer a request that builds nothing. */
export const answerTime = async (): Promise<number> => {
  const started = Date.now();
  const response = await exports.default.fetch("https://core/health");
  await response.text();
  return Date.now() - started;
};

/**
 * Core's env as on-prem, its assets answering `probeModule` in place of
 * the program at `program` (`/compiler.js`, `/package-builder.js`): what
 * runs there is the probe, on the sandbox host, as that program runs.
 */
export const probing = (program: string) => ({
  ...onPrem,
  ASSETS: {
    fetch: async (...args: Parameters<Fetcher["fetch"]>) =>
      new Request(...args).url.endsWith(program)
        ? new Response(probeModule, {
            headers: { "content-type": "text/javascript" },
          })
        : await env.ASSETS.fetch(...args),
    connect: env.ASSETS.connect.bind(env.ASSETS),
  },
});
