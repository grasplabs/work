import { z } from "zod";

// Changes to the organization's teams, as an admin makes them: through
// Better Auth's organization routes, which core serves under `/api/auth`
// (auth/routes.ts), checks the role on (only admins may) and audits
// (auth/auth.ts). Reading them all is core's (`members.teams()`), as Better
// Auth lists a team's members only to those in it.

/** A team change that didn't go through: `status` is the HTTP status. */
export class TeamChangeError extends Error {
  readonly status: number;
  /** Better Auth's error code, when its answer names one. */
  readonly code: string | undefined;

  constructor(path: string, status: number, code?: string) {
    super(`${path} failed (${status})`);
    this.name = "TeamChangeError";
    this.status = status;
    this.code = code;
  }
}

/** The `code` of a refusal Better Auth answers, if it names one. */
const codeOf = async (response: Response): Promise<string | undefined> => {
  try {
    const parsed = z
      .object({ code: z.string() })
      .safeParse(await response.json());
    return parsed.success ? parsed.data.code : undefined;
  } catch {
    return undefined;
  }
};

/** Sends one change to Better Auth; throws when it didn't go through. */
const change = async (path: string, body: unknown): Promise<void> => {
  const response = await fetch(`/api/auth/organization/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new TeamChangeError(path, response.status, await codeOf(response));
  }
};

export const createTeam = async (name: string): Promise<void> => {
  await change("create-team", { name });
};

export const renameTeam = async (
  teamId: string,
  name: string
): Promise<void> => {
  await change("update-team", { teamId, data: { name } });
};

export const deleteTeam = async (teamId: string): Promise<void> => {
  await change("remove-team", { teamId });
};

export const addTeamMember = async (
  teamId: string,
  userId: string
): Promise<void> => {
  await change("add-team-member", { teamId, userId });
};

export const removeTeamMember = async (
  teamId: string,
  userId: string
): Promise<void> => {
  await change("remove-team-member", { teamId, userId });
};
