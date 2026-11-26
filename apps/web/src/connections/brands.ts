import type { OAuthProvider } from "@grasp-os/shared/connect";
import type { IconData } from "@grasp-os/ui/lib/icons";

import { GoogleLogo, HubSpotLogo, MicrosoftLogo } from "./brand-logos.ts";

// The marks the product draws itself, for Grasp's own connectors: core
// serves no logo for them (their `CatalogEntry.logo` is null), unlike a
// Composio toolkit's. Keyed by the connector's id, the one thing that
// picks one (provider-mark.tsx); Recommended draws a suite's beside its
// reason. The marks are the ones sign-in draws (brand-logos.ts).

/** The mark of each of Grasp's own connectors, by its id, and the name its company goes by. */
const suites = {
  microsoft: { logo: MicrosoftLogo, name: "Microsoft" },
  google: { logo: GoogleLogo, name: "Google" },
} as const satisfies Record<OAuthProvider, { logo: IconData; name: string }>;

/**
 * Each mark the product draws, by the connector's or toolkit's id exactly:
 * the suites', and HubSpot's for a HubSpot connection the catalog doesn't
 * list (core serves its logo only with the catalog), as #2503 draws it.
 */
export const brands = {
  ...suites,
  hubspot: { logo: HubSpotLogo, name: "HubSpot" },
} as const;

/** A connector with a mark of its own. */
export type Brand = keyof typeof brands;

/** Whether the product has its own mark for the connector `id`, by that id exactly. */
export const isBrand = (id: string): id is Brand => Object.hasOwn(brands, id);
