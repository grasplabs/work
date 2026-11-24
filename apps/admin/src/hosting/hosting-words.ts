import type { OrganizationHosting } from "./organization.ts";

/** Where an organization runs, in a few plain words. */
export const hostingWords = ({
  hosting,
  jurisdiction,
}: OrganizationHosting): string => {
  if (hosting === "on_prem") {
    return "On-premises: on the organization's own servers";
  }
  return jurisdiction === "eu"
    ? "Grasp Cloud, data kept in the EU"
    : "Grasp Cloud, data stored anywhere in Cloudflare's network";
};
