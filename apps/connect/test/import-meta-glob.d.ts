// Vite's `import.meta.glob`, for the tests only: connectors.test.ts lists
// the files the check of every native tool is split over
// (scripts/test-file-parts.ts). Only `glob`, not Vite's client types:
// wrangler's esbuild supports neither `glob` nor `env`, so Worker code
// must not use them. Connect has one tsconfig, so this is visible to src
// too; nothing there calls it.
interface ImportMeta {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}
