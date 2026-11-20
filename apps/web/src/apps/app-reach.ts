import type { App } from "@grasp-os/shared/apps";
import type { SubjectMember } from "@grasp-os/shared/subject-members";

// How the person reaches an App, for the Apps page's three tabs: their own
// (they made it or answer for it), shared with them by name, or the
// company's (shared with a team or project of theirs, or open to them as an
// admin, who manages every App).

export type AppReach = "mine" | "shared" | "company";

/** Whether `person` made `app` or answers for it. */
export const isMine = (
  app: Pick<App, "owner" | "responsible">,
  person: string
): boolean => app.owner === person || app.responsible === person;

/** Whether `members` share the App with `person` by name. */
export const sharedWith = (
  members: readonly SubjectMember[],
  person: string
): boolean =>
  members.some((member) => member.type === "person" && member.id === person);

/** How `person` reaches `app`, given the Apps shared with them by name. */
export const reachOf = (
  app: Pick<App, "id" | "owner" | "responsible">,
  person: string,
  sharedWithThem: ReadonlySet<string>
): AppReach => {
  if (isMine(app, person)) {
    return "mine";
  }
  return sharedWithThem.has(app.id) ? "shared" : "company";
};
