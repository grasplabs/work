import { createFileRoute, useRouteContext } from "@tanstack/react-router";

import { MemoriesPage } from "../brain/memories-page.tsx";

// Brain › Memories: what the new Brain remembers that the person may
// read, where each memory came from, and the facts sources disagree on
// (GRA-1746). The person's teams are whom they may share a memory of
// their own with (GRA-1815).

const Memories = () => {
  const { identity } = useRouteContext({ from: "/_shell" });
  return <MemoriesPage teams={identity.teams} />;
};

export const Route = createFileRoute("/_shell/brain/memories")({
  component: Memories,
});
