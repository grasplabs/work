import { brainEntityKinds } from "@grasp-os/shared/brain-memories";
import type {
  BrainEntityKind,
  BrainEntityRef,
} from "@grasp-os/shared/brain-memories";
import { createFileRoute, useRouteContext } from "@tanstack/react-router";

import { MemoriesPage } from "../brain/memories-page.tsx";

// Brain › Memories: what the new Brain remembers that the person may
// read, where each memory came from, and the facts sources disagree on
// (GRA-1746). The person's teams are whom they may share a memory of
// their own with (GRA-1815). An entity in the address opens first, as
// the Sources page links to one (GRA-1991): its panel reads it as the
// person may read it now, so an address names nothing they may not see.

interface MemoriesSearch {
  store?: BrainEntityRef["store"];
  entity?: string;
  kind?: BrainEntityKind;
}

const Memories = () => {
  const { identity } = useRouteContext({ from: "/_shell" });
  const { store, entity, kind } = Route.useSearch();
  return (
    <MemoriesPage
      teams={identity.teams}
      {...(store === undefined || entity === undefined || kind === undefined
        ? {}
        : { open: { entity: { store, id: entity }, kind } })}
    />
  );
};

export const Route = createFileRoute("/_shell/brain/memories")({
  validateSearch: (search: Record<string, unknown>): MemoriesSearch => {
    const store = (["own", "shared"] as const).find(
      (each) => each === search.store
    );
    const kind = brainEntityKinds.find((each) => each === search.kind);
    return {
      ...(store === undefined ? {} : { store }),
      ...(typeof search.entity === "string" && search.entity !== ""
        ? { entity: search.entity }
        : {}),
      ...(kind === undefined ? {} : { kind }),
    };
  },
  component: Memories,
});
