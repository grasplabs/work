// What ships without its own types: two ESLint plugins (their rules),
// and Ultracite's Prettier config.
declare module "eslint-plugin-jsx-a11y" {
  const plugin: { rules?: Record<string, unknown> };
  export default plugin;
}

declare module "eslint-plugin-promise" {
  const plugin: { rules?: Record<string, unknown> };
  export default plugin;
}

declare module "ultracite/prettier" {
  import type { Config } from "prettier";

  const config: Config;
  export default config;
}
