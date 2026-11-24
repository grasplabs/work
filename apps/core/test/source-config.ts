import { env } from "cloudflare:workers";

/**
 * A webhook trigger's configuration on a source of its own, made straight
 * in the database as an admin's would be (event-sources.ts): for a test
 * that needs a trigger, not what starts it.
 */
export const webhookConfig = async (
  type = "test.event"
): Promise<{ source: string; type: string }> => {
  const source = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO event_sources (id, name, token, secret_generation, created_by, created_at) VALUES (?, 'Test source', ?, 1, 'test', ?)"
  )
    .bind(source, source.replaceAll("-", ""), Date.now())
    .run();
  return { source, type };
};
