import files from "../../packages/embed/test/fixtures/files.json" with { type: "json" };
import { shippedModelPlugin } from "./test/shipped-model-plugin.ts";
import { coreProject } from "./vite.config.ts";

// Recall by meaning through core (test/brain-next-meaning.test.ts): core
// as if the embed package's int8 test model shipped
// (test/shipped-model-plugin.ts), with EMBEDDER bound to that model's
// breakable embedder (test/meaning-worker.ts), so the test can break the
// question embedder. In code no model ships, so core's other projects
// never embed; this one alone does.
export default coreProject(
  {
    name: "@grasp-os/core:brain-meaning",
    include: ["test/brain-next-meaning.test.ts"],
  },
  {
    main: "./test/meaning-worker.ts",
    durableObjects: {
      EMBEDDER: { className: "BreakableEmbedder", useSQLite: true },
    },
    plugins: [
      // The test model as the embed package names it (test-models.ts
      // `int8Model`), so core's build of it is the embedder's.
      shippedModelPlugin({
        name: "fixture-int8",
        tokenizer: files["tokenizer.bin"],
        encoder: files["encoder-int8.bin"],
        tokens: files["tokens-int8.bin"],
      }),
    ],
  }
);
