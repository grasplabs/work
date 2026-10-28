// react-refresh ships no types: its Babel plugin, as compile.ts uses it.
declare module "react-refresh/babel" {
  const plugin: (babel: unknown, options?: unknown) => unknown;
  export default plugin;
}
