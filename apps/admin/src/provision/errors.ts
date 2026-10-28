/** Why staff's action on a client's provisioning was refused, as the page shows it. */
export const provisionErrorCodes = [
  /** The admin has no CLIENT_DOMAIN, so no client can get a hostname. */
  "domain_not_set",
  /** A client of that id exists already. */
  "client_exists",
  /** A run for that client is still going, or another staff member just started or resumed one. */
  "already_running",
  /** The client isn't being provisioned, so there's nothing to do. */
  "not_provisioning",
  /** Its sign-in names an IdP the admin has no OAuth app id for. */
  "sign_in_app_missing",
] as const;
export type ProvisionErrorCode = (typeof provisionErrorCodes)[number];

export class ProvisionError extends Error {
  readonly code: ProvisionErrorCode;

  constructor(code: ProvisionErrorCode, message: string) {
    super(message);
    this.name = "ProvisionError";
    this.code = code;
  }
}
