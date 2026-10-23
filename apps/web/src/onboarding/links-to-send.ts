import type { LinkToSend } from "@grasp-os/shared/onboarding";

import { toCsv } from "../landscape/landscape.ts";

// The links the company's admin sends themselves, from what core gives
// (`onboarding.links()`): which are out, which are new since they last
// took some, and the list they take. Pure.

/** The links out, the new ones among them, and the ones a list takes: the new ones, or all out when none are new. */
export const linksOf = (
  links: readonly LinkToSend[]
): { out: LinkToSend[]; fresh: LinkToSend[]; list: LinkToSend[] } => {
  const out = links.filter((link) => link.path !== null);
  const fresh = out.filter((link) => link.fresh);
  return { out, fresh, list: fresh.length > 0 ? fresh : out };
};

/** Someone's whole link, on this page's address. */
export const fullLink = (path: string, origin: string): string =>
  `${origin}${path}`;

/**
 * The links as a CSV file to mail-merge: a header row in the page's
 * language, then one row per person. Safe to open in a spreadsheet.
 */
export const linksCsv = (
  links: readonly LinkToSend[],
  origin: string,
  header: readonly [string, string, string, string]
): string =>
  toCsv([
    header,
    ...links.flatMap((link) =>
      link.path === null
        ? []
        : [[link.name, link.email, link.team, fullLink(link.path, origin)]]
    ),
  ]);
