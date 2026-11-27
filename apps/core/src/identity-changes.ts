import { errorFields, log } from "@grasp-os/shared/log";
import { waitUntil } from "cloudflare:workers";

import { callObject, workspace } from "./durable-objects.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";

// Telling a person's open connections that their session or who they are
// may have changed (person-connections.ts): every write that ends a
// session or changes someone's role, teams or membership calls
// `identityChanged` once it has committed, and each connection of theirs
// reads its session again at once. Never waited for nor thrown for: the
// write landed, and a connection reads its session again anyway before a
// call or a push once its reading is older than `sessionRecheckMs`
// (session-check.ts). The telling makes that seconds bound about one
// second, and closes an idle tab that would otherwise stay open showing
// what it had until its next call.

/** Tells each person's object, retrying a call a reset broke. */
const tell = async (env: Env, userIds: ReadonlySet<string>): Promise<void> => {
  await Promise.all(
    [...userIds].map(async (userId) => {
      try {
        await callObject(async () => {
          await workspace(env, personalWorkspaceId(userId)).identityChanged();
        });
      } catch (error) {
        log.warn("identity.untold", errorFields(error));
      }
    })
  );
};

/**
 * Tells the open connections of `userIds` to read their session again:
 * after the write that changed it committed, behind the request.
 */
export const identityChanged = (
  env: Env,
  userIds: Iterable<string | null | undefined>
): void => {
  const people = new Set(
    [...userIds].filter(
      (userId): userId is string => typeof userId === "string"
    )
  );
  if (people.size > 0) {
    waitUntil(tell(env, people));
  }
};
