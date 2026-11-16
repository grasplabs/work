import { env } from "cloudflare:workers";

/**
 * A permission stored as it is, past the checks a request and a grant
 * make, as a bug or an old record could leave one: active by default, for
 * the reads and calls to refuse what it shouldn't allow on their own, or
 * requested, for a grant to refuse. Returns its ID.
 */
export const storedGrant = async (
  subject: { type: "app" | "agent"; id: string },
  object: { type: "collection" | "connection" | "platform"; id: string },
  actions: string[],
  binding: string,
  status: "active" | "requested" = "active"
): Promise<string> => {
  const id = crypto.randomUUID();
  const grantedBy = status === "active" ? "test" : null;
  const grantedAt = status === "active" ? 0 : null;
  await env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
      actions, binding, status, requested_by, requested_at, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', 0, ?, ?)`
  )
    .bind(
      id,
      subject.type,
      subject.id,
      object.type,
      object.id,
      JSON.stringify(actions),
      binding,
      status,
      grantedBy,
      grantedAt
    )
    .run();
  return id;
};
