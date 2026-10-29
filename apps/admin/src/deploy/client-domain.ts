/** The admin has no `CLIENT_DOMAIN`, so no client can be deployed. */
export class ClientDomainUnsetError extends Error {
  constructor() {
    super("CLIENT_DOMAIN isn't set: no client can be deployed");
    this.name = "ClientDomainUnsetError";
  }
}
