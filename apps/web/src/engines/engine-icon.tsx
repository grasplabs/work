import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import { CogIcon } from "lucide-react";

import { ProcessTile } from "../workflows/business-process.tsx";

/**
 * A domain's icon on a grey tile, as the prototype draws an engine
 * (`components/engines/engine-icon.tsx`): its business process's, or a
 * cog for one that serves none.
 */
export const EngineIcon = ({
  process = null,
}: {
  process?: BusinessProcess | null;
}) => {
  if (process !== null) {
    return <ProcessTile process={process} />;
  }
  return (
    <span
      aria-hidden="true"
      className="bg-muted text-foreground inline-flex size-7.5 flex-none items-center justify-center rounded-lg"
    >
      <CogIcon className="size-4" />
    </span>
  );
};
