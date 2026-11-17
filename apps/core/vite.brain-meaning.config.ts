import { coreProject } from "./vite.config.ts";

// Recall by meaning through core (test/brain-next-meaning.test.ts): core
// running the embed package's int8 test model, as every core project does,
// with EMBEDDER bound to that model's breakable embedder
// (test/meaning-worker.ts), so the test can break the question embedder.
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
  }
);
