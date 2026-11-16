/**
 * Core's build, step by step, each run from core's folder: the App
 * compiler, the extractor and the SDK docs, each into its own place in the
 * frontend's static files (`../web/dist`, so after the frontend's build,
 * which empties it), and the blueprints and the agent's docs into dist/.
 * Each reads only sources and writes only its own files, so they run at
 * once: core's `build` task (vite.config.ts) runs `last` after the rest,
 * and the e2e stack's build (e2e/build.ts) runs them all beside the
 * frontend's build. One after another they took 39 s of the release build
 * on CI, 19 s of it the compiler's and 17 s the docs' (November 2026).
 */
export const frontendDist = "../web/dist";

export const buildSteps = {
  compiler: `node ../../packages/compiler/build.ts ${frontendDist}`,
  extractor: `node build-extractor.ts ${frontendDist}`,
  docs: `node ../docs/build.ts ${frontendDist}/docs`,
  blueprints: "node build-blueprints.ts",
} as const;

/** The step `build` itself runs, once the others have ended. */
export const lastBuildStep = "node build-agent-docs.ts";
