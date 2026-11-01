import { useAction } from "../use-action.ts";
import type { ProvisionErrorCode } from "./errors.ts";

/** What staff read when the admin refuses a change, by its code. */
const refusals: Readonly<Record<ProvisionErrorCode, string>> = {
  domain_not_set:
    "The admin has no CLIENT_DOMAIN yet, so no client can get a hostname.",
  sign_in_app_missing:
    "The admin has no OAuth app for that IdP yet: set ENTRA_CLIENT_ID or GOOGLE_CLIENT_ID on it first.",
  client_exists: "A client with that id exists already: open its page.",
  already_running: "Its provisioning is running already.",
  not_provisioning: "It isn't being provisioned, so there's nothing to do.",
};

/** A staff action on a client's provisioning (`useAction`), its refusals worded. */
export const useProvisionAction = () => useAction(refusals);
