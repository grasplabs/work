// Prism's language files add their grammar to the global Prism and export nothing
// (code-block-worker.ts, which references this file). Shipped with code-block, so a project that
// installs it type-checks, in the package it lands in and in an app that imports it.
declare module "prismjs/components/*";
