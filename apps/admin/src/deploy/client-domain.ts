/** The admin has no `CLIENT_DOMAIN`, so no client can be deployed. */
import "@tanstack/react-start/server-only";

export class ClientDomainUnsetError extends Error {
  constructor() {
    super("CLIENT_DOMAIN isn't set: no client can be deployed");
    this.name = "ClientDomainUnsetError";
  }
}
