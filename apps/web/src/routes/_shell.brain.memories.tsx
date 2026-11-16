import { createFileRoute } from "@tanstack/react-router";

import { MemoriesPage } from "../brain/memories-page.tsx";

// Brain › Memories: what the new Brain remembers that the person may
// read, where each memory came from, and the facts sources disagree on
// (GRA-1746).

export const Route = createFileRoute("/_shell/brain/memories")({
  component: MemoriesPage,
});
