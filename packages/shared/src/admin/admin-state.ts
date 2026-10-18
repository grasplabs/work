import { notesOf } from "./onboarding-admin.ts";
import type { Org, OrgState } from "./onboarding-admin.ts";

/**
 * Where an organization stands: where it starts, with what Grasp's staff did to it on top. What
 * the organization keeps itself (its own steps, its day, who is away, which teams take part) goes
 * over anything kept by hand for a real one. The admin's page and the Worker's MCP both read an
 * organization through this, so the two never disagree. Pure.
 */
export const stateWith = (org: Org, done: Partial<OrgState>): OrgState => ({
  ...org.seed,
  ...done,
  agreed: { ...org.seed.agreed, ...done.agreed },
  rules: { ...org.seed.rules, ...done.rules },
  // Notes kept as one text before they were a list become the first of the list.
  notes: notesOf(done.notes ?? org.seed.notes),
  ...(org.real
    ? {
        client: org.seed.client,
        day: org.seed.day,
        away: org.seed.away,
        left: org.seed.left,
      }
    : {}),
});
