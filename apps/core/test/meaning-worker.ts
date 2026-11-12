// The Worker core's test of recall by meaning runs (vite.brain-meaning
// .config.ts): core as deployed, with the embed package's breakable
// embedder of its int8 test model beside it, which that project binds as
// EMBEDDER, so a test can break the question embedder as an outage would.
// oxlint-disable-next-line oxc/no-barrel-file -- every class core's Worker exports, as wrangler.jsonc names them
export * from "../src/index.ts";
export { default } from "../src/index.ts";
export { BreakableEmbedder } from "../../../packages/embed/test/test-models.ts";
