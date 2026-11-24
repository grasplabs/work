// Vite's `import.meta.glob`, for the tests only (skills.test.ts and
// builtin-blueprints.test.ts list folders with it, and the coverage tests
// of runs split over files list those files: scripts/test-file-parts.ts).
// Only `glob`, not Vite's client types: wrangler's esbuild supports
// neither `glob` nor `env`, so Worker code must not use them. Core has one
// tsconfig, so this is visible to src too; nothing there calls it.
interface ImportMeta {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}
