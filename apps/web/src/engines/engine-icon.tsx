import { CogIcon } from "lucide-react";

/**
 * An engine's icon on a grey tile, as the prototype draws an engine
 * someone made (`components/engines/engine-icon.tsx`): a cog. Every
 * engine here is one someone made; none stands for a business process yet.
 */
export const EngineIcon = () => (
  <span
    aria-hidden="true"
    className="bg-muted text-foreground inline-flex size-7.5 flex-none items-center justify-center rounded-lg"
  >
    <CogIcon className="size-4" />
  </span>
);
