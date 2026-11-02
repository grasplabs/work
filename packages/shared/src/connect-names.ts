import { z } from "zod";

// Apart from connect.ts, which re-exports them: the web app checks these in
// its addresses before a page loads, without the rest of the connector
// layer's schemas.

/**
 * The suites a person connects through OAuth, pinned to the organization's
 * own tenant: the IdPs people sign in with.
 */
export const oauthProviderSchema = z.enum(["microsoft", "google"]);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

/**
 * Grasp's kinds of app, in the order the Integrations page lists them. Each
 * id is the group's English name, which the web app translates; `Other` is
 * for an app none of the others fits.
 */
export const catalogGroups = [
  "Email and calendar",
  "Files and documents",
  "Chat",
  "CRM",
  "Finance and accounting",
  "HR",
  "Signing",
  "Marketing",
  "Support",
  "Projects and tasks",
  "Forms and surveys",
  "Data and analytics",
  "AI",
  "Commerce",
  "Design and media",
  "Developer tools",
  "Other",
] as const;
export type CatalogGroup = (typeof catalogGroups)[number];
