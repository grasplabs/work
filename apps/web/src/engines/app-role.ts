import type { Identity } from "@grasp-os/shared/rpc";

// Whether a page offers changes to an App: to its builders, by their role
// in that App as core reads it (`ViewedApp.role`), never by their role in
// the organization, which only caps it. Grasp staff change no App, though
// core counts them builders of every one, as admins. Core refuses anyone
// else all the same; this only keeps a page from offering what it would.

/** Whether `identity` changes `app` on its pages. */
export const buildsApp = (
  app: { role: "user" | "builder" },
  identity: Pick<Identity, "staff">
): boolean => app.role === "builder" && !identity.staff;
