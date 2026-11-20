import { brainTeamsSchema } from "@grasp-os/shared/permissions";

// The teams an App's grant to read the Brain names (GRA-1842), as the
// `permissions.teams` column stores them: JSON text, read by hand, never by
// the database driver's JSON mode, so one malformed row is that grant's
// problem alone and no listing of everyone's permissions or Apps breaks
// on it.

/**
 * A team nobody is in: what a stored value that isn't a JSON list of team
 * IDs counts as wherever a grant is shown or checked, so what holds it is
 * closed to everyone (fail closed), never opened.
 */
export const unreadableTeam = "*";

/**
 * The team IDs `stored` names: none for NULL, and otherwise exactly what
 * `brainTeamsSchema` accepts, the schema a request is checked with, or
 * undefined for anything else (not JSON, not a list, empty, too long, a
 * team twice, an element that isn't a team ID). One schema decides, so no
 * shape a request couldn't make reaches a reader.
 */
export const storedTeamsOf = (stored: string | null): string[] | undefined => {
  if (stored === null) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return undefined;
  }
  const parsed = brainTeamsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
