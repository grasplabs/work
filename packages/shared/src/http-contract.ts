// Apart and with nothing imported: the runtime in every App's bundle names
// it in `permission.connection`, and can't bring Zod along
// (http-connections.ts has the schemas).

/**
 * The connector contract every HTTP connection serves (connect's
 * contracts.ts): an outside API an admin approved, its one origin, the
 * paths and methods it allows, and its credential, which connect adds and
 * nobody else sees. Its actions are `get` (a read: GET or HEAD) and `send`
 * (POST, PUT, PATCH or DELETE, a change a person confirms where they are
 * there); its client also has `fetch`, which picks the action by the
 * method. An App's `permission.connection` names it; a workflow names a
 * contract of the host's catalog instead, which any connection serving its
 * operations can be bound to (core's release-contracts.ts).
 */
export const httpContract = "http.request@1";
export type HttpContract = typeof httpContract;
