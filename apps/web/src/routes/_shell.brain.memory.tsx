import { isMemberAdmin } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";

import { MemoryPage } from "../brain/memory-page.tsx";

// The Brain's memory records, inside the brain (GRA-298): a person's own
// and those shared with them, each with its lineage and correction.

const Memory = () => {
  const { identity } = Route.useRouteContext();
  return <MemoryPage admin={isMemberAdmin(identity)} />;
};

export const Route = createFileRoute("/_shell/brain/memory")({
  component: Memory,
});
