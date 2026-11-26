import { connectDb } from "./test-env.ts";

/**
 * Pauses connection `connectionId` until `until` (ms), or ends its pause
 * with a time past, as connect keeps a pause its vendor asked for
 * (tokens.ts `pauseFor`): written directly, as core's tests' mail server
 * is a Composio toolkit's, which connect never pauses itself (only a
 * native connector's throttled answer does).
 */
export const pause = async (
  connectionId: string,
  until: number
): Promise<void> => {
  await connectDb()
    .prepare(
      "INSERT INTO connection_tokens (connection_id, sealed, access_expires_at, generation, updated_at, paused_until) VALUES (?, '', ?, 0, ?, ?) ON CONFLICT (connection_id) DO UPDATE SET paused_until = excluded.paused_until"
    )
    .bind(connectionId, until, Date.now(), until)
    .run();
};
