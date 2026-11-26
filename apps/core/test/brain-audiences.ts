import type {
  ConnectionAudience,
  ConnectionsApi,
} from "@grasp-os/shared/connect";

// Choosing a shared connection's Brain audience in a test as an admin
// looking at it now would (connection-audiences.ts): from the audience
// core holds at that moment. A test of a change from a stale audience
// calls `setAudience` with its own `from`.

/** Whoever chooses: a session's API. */
interface Chooser {
  connections: Pick<ConnectionsApi, "audiences" | "setAudience">;
}

/** The audience core holds for `connectionId` now, as `api` may read it: nobody if it may not. */
export const audienceNow = async (
  api: Chooser,
  connectionId: string
): Promise<ConnectionAudience> => {
  try {
    const listed = await api.connections.audiences();
    return (
      listed.find((each) => each.connectionId === connectionId)?.audience ?? {
        kind: "nobody",
      }
    );
  } catch {
    // Refused the listing (not an admin): refused the change alike.
    return { kind: "nobody" };
  }
};

/**
 * Chooses `audience` for `connectionId` as `api`, from the one held now,
 * confirming that it reads everything the connection brings.
 */
export const chooseAudience = async (
  api: Chooser,
  connectionId: string,
  audience: ConnectionAudience
): Promise<void> => {
  await api.connections.setAudience(
    connectionId,
    audience,
    await audienceNow(api, connectionId),
    audience
  );
};
