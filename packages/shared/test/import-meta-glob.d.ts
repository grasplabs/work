// Vite's `import.meta.glob`, for the tests only (error-namespaces.test.ts
// finds the modules that define error families with it). Only `glob`, not
// Vite's client types, which the package's runtime code must not use.
interface ImportMeta {
  glob: (
    patterns: string | readonly string[],
    options?: { readonly query?: string; readonly import?: string }
  ) => Record<string, () => Promise<unknown>>;
}
