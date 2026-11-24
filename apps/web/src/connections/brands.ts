import type { OAuthProvider } from "@grasp-os/shared/connect";
import type { IconData } from "@grasp-os/ui/lib/icons";

import { GoogleLogo, MicrosoftLogo } from "./brand-logos.ts";

// The marks the product draws itself, for Grasp's own connectors: core
// serves no logo for them (their `CatalogEntry.logo` is null), unlike a
// Composio toolkit's. Keyed by the connector's id, the one thing that
// picks one (provider-mark.tsx); Recommended draws a suite's beside its
// reason. The marks are the ones sign-in draws (brand-logos.ts).

/** The mark of each of Grasp's own connectors, by its id, and the name its company goes by. */
export const brands = {
  microsoft: { logo: MicrosoftLogo, name: "Microsoft" },
  google: { logo: GoogleLogo, name: "Google" },
} as const satisfies Record<OAuthProvider, { logo: IconData; name: string }>;

/** A connector with a mark of its own. */
export type Brand = keyof typeof brands;
