import {
  emailPreferenceChangesSchema,
  emailPreferenceErrors,
} from "@grasp-os/shared/email-preferences";
import type {
  EmailPreferenceChanges,
  EmailPreferences,
  EmailPreferencesApi,
} from "@grasp-os/shared/email-preferences";

import { personalWorkspaceId } from "./chats-rpc.ts";
import { workspace } from "./durable-objects.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// A signed-in person's own choice of the emails Grasp sends them, over
// `/rpc`. Kept in their own Workspace object, as their dashboard is
// (dashboard-rpc.ts), reached only with the signed-in person as the
// session check hands them over, so nobody reads or saves another's.
// Not audited: it changes what one person is sent of what they may
// already see, as marking notifications read does.

/** The signed-in person's email preferences. */
export class EmailPreferencesRpc
  extends CoreRpcTarget
  implements EmailPreferencesApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async get(): Promise<EmailPreferences> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await workspace(
          this.#env,
          personalWorkspaceId(userId)
        ).emailPreferences(userId)
    );
  }

  async save(changes: EmailPreferenceChanges): Promise<void> {
    await withPerson(this.#check, async ({ userId }) => {
      const checked = emailPreferenceErrors.parse(
        "email_preferences.invalid",
        emailPreferenceChangesSchema,
        changes
      );
      await workspace(
        this.#env,
        personalWorkspaceId(userId)
      ).saveEmailPreferences(userId, checked);
    });
  }
}
