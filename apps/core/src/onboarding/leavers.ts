import { errorFields, log } from "@grasp-os/shared/log";

import { leftAmong, tieKey } from "./staff-ties.ts";
import { onboardingStore } from "./store.ts";

/**
 * Marks who on the staff list left the organization (GRA-2249): each
 * entry tied to someone in the directory, as core finds them now
 * (staff-ties.ts `leftAmong`). After the daily read applies (`read`):
 * whom it no longer holds and who was removed, and no longer anyone else,
 * so each read puts right whatever a look before it left. After a
 * removal: who was removed, marked only, as the read may be a day old.
 */
export const markLeavers = async (
  env: Env,
  after: "read" | "removal"
): Promise<void> => {
  const store = onboardingStore(env);
  const listed = await store.staffTies();
  const ties = listed.flatMap(({ tie }) =>
    tie === null ? [] : [{ suite: tie.suite, id: tie.id }]
  );
  if (ties.length === 0) {
    return;
  }
  const asOf = new Date().toISOString();
  const left = await leftAmong(env, ties, { byRead: after === "read" });
  await store.markLeft(
    after === "read" ? ties : [],
    ties.filter((tie) => left.has(tieKey(tie))),
    asOf
  );
};

/**
 * `markLeavers`, for what it follows: a failure is logged and leaves the
 * marks as they were, for the next read; what it follows stands.
 */
export const markLeaversQuietly = async (
  env: Env,
  after: "read" | "removal"
): Promise<void> => {
  try {
    await markLeavers(env, after);
  } catch (error) {
    log.warn("onboarding.leavers_failed", { after, ...errorFields(error) });
  }
};
