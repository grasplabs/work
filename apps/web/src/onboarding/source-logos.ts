import type { DocumentSource } from "./setup.ts";

// The logos of the places documents live, for the sources step: each
// place's own, in its own colours, as files in `public/logos`. Vendored:
// microsoft-onedrive, microsoft-teams, google-drive, confluence and notion
// (notion-icon) from the gilbarbara/logos set (CC0), as Stephen's settings
// take Teams and Slack; microsoft-sharepoint, which that set lacks, from
// theSVG (MIT). The trademarks stay with their owners; they are shown only
// to name the place. Dropbox and Box from the same set. The HR platforms':
// Personio, HiBob, Loket (its loket.nl badge) and Workday from theSVG (MIT); Nmbrs's mark from its own logo and
// AFAS’s word traced from the logo artwork Ruben sent.

const logos: Readonly<Record<string, string>> = {
  sharepoint: "/logos/microsoft-sharepoint.svg",
  onedrive: "/logos/microsoft-onedrive.svg",
  teams: "/logos/microsoft-teams.svg",
  drive: "/logos/google-drive.svg",
  confluence: "/logos/confluence.svg",
  notion: "/logos/notion.svg",
};

/**
 * Places many companies keep documents in that Grasp doesn't connect to
 * yet: offered as tiles with their logos, and noted by name when pressed,
 * as a place typed in is. Their names are product names, not translated.
 */
export const namedPlaces = [
  { name: "Dropbox", logo: "/logos/dropbox.svg" },
  { name: "Box", logo: "/logos/box.svg" },
] as const;

/** The logo a place carries, by its address; none for a place Grasp has no logo for. */
export const sourceLogo = (source: DocumentSource): string | null =>
  logos[source.id] ?? null;
