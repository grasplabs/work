/**
 * What's wrong with a web address staff typed for an organization, in
 * plain words, checked with the same rule the server applies
 * (`newClientIdSchema`), so the form says so as it is typed.
 */
import { newClientIdSchema, reservedClientIds } from "@grasp-os/shared/router";

/** The longest an organization's web address may be. */
export const maxClientIdLength = 50;

const allowed = /^[a-z0-9-]*$/u;

/** Why `id` can't be an organization's web address, or null when it can. */
export const clientIdProblem = (id: string): string | null => {
  if (newClientIdSchema.safeParse(id).success) {
    return null;
  }
  if (id === "") {
    return "Give it a web address.";
  }
  if (reservedClientIds.has(id)) {
    return `${id} is reserved for Grasp itself: choose another.`;
  }
  if (!allowed.test(id)) {
    return "Use only lowercase letters, digits and dashes.";
  }
  if (id.length > maxClientIdLength) {
    return `Keep it to ${maxClientIdLength} characters at most.`;
  }
  return "Start and end it with a letter or digit.";
};
