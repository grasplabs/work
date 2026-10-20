import { NotLoaded } from "../load-from-core.tsx";
import type { LandscapeData } from "./landscape-data.ts";

/**
 * Why part of the Landscape didn't load: its integrations, or the apps
 * found in the identity provider, each said apart, so a list that shows is
 * never taken for the whole one. The second only when the first loaded:
 * when both fail, it is mostly for the same reason.
 */
export const LandscapeNotLoaded = ({
  integrations,
  found,
}: Pick<LandscapeData, "integrations" | "found">) => (
  <>
    <NotLoaded page={integrations} />
    {integrations.state === "ready" ? <NotLoaded page={found} /> : null}
  </>
);
