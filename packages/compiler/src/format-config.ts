/**
 * How App code is formatted, wherever it is: in Grasp (ultracite.ts
 * `tidy`) and in an exported App, whose Prettier config is this, written
 * as data (scripts/package-definition-lib.ts). Ultracite's config, with a
 * template's embedded language (CSS, GraphQL, HTML, Markdown) left as
 * written: Grasp's standalone Prettier loads only TypeScript's printer.
 */
import ultracite from "ultracite/prettier";

export const formatConfig = {
  ...ultracite,
  embeddedLanguageFormatting: "off",
} as const;
