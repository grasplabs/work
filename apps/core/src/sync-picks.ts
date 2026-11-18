import { actorOf } from "@grasp-os/shared/audit";
import type {
  ConnectionPerson,
  SharedSyncPlaces,
} from "@grasp-os/shared/connect";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { syncErrors, syncPicksSchema } from "@grasp-os/shared/sync";
import { z } from "zod";

import { appendAuditEvent } from "./audit-outbox.ts";

// The places of a shared connection an admin picks to sync into the Brain
// (GRA-1758, GRA-1759): its connector's shared drives or SharePoint
// libraries, as connect lists what the connected account can see, and
// which of them are picked. Connect keeps the picks, refuses a read of any
// other place, and audits every change and refusal it sees (apps/connect's
// sync.ts); core lets only the company's own admins ask (Grasp staff hold
// no admin role here), and records the refusal of anyone else, which
// connect never sees. Who may
// read what a picked place brings is the connection's Brain audience
// (connection-audiences.ts), not the source's permissions.

const connectionIdSchema = z.string().min(1).max(128);

const pickSchema = z.strictObject({
  connectionId: connectionIdSchema,
  feed: z.string().regex(/^[a-z][a-z\d-]{0,63}$/u),
  from: syncPicksSchema,
  places: syncPicksSchema,
});

/**
 * Refuses, with `role.forbidden`, anyone but one of the company's admins,
 * and records the refusal: connect, which audits the rest, never sees
 * this call.
 */
const requireCompanyAdmin = async (
  env: Env,
  identity: Identity,
  connectionId: unknown
): Promise<void> => {
  if (isAdmin(identity.role)) {
    return;
  }
  const id = connectionIdSchema.safeParse(connectionId);
  await appendAuditEvent(env, {
    actor: actorOf(identity),
    action: "connection.sync_places",
    ...(id.success ? { target: { type: "connection", id: id.data } } : {}),
    detail: { outcome: "refused", reason: "role.forbidden" },
  });
  throw roleErrors.create("role.forbidden");
};

/**
 * Every place of the shared connection `connectionId` an admin may pick,
 * with whether each is picked, read whole: connect answers a read at a
 * time, and the picks an admin saves replace the whole set, so the page
 * must see every place before it saves. Null when the connection has no
 * sync of picked places (a personal one, a Composio one, a connector
 * without one).
 */
export const readSyncPlaces = async (
  env: Env,
  identity: Identity,
  person: () => Promise<ConnectionPerson>,
  connectionId: unknown
): Promise<SharedSyncPlaces | null> => {
  await requireCompanyAdmin(env, identity, connectionId);
  const id = syncErrors.parse("sync.invalid", connectionIdSchema, connectionId);
  const asking = await person();
  const read = async (feed: string | undefined, cursor: string | null) =>
    await env.CONNECT.syncPlaceChoices({
      person: asking,
      connectionId: id,
      ...(feed === undefined ? {} : { feed }),
      cursor,
    });
  const first = await read(undefined, null);
  if (first === null) {
    return null;
  }
  const choices = [...first.choices];
  let { cursor } = first;
  while (cursor !== null) {
    // oxlint-disable-next-line no-await-in-loop -- one read after another, each from the last one's cursor
    const next = await read(first.feed, cursor);
    if (next === null) {
      return null;
    }
    choices.push(...next.choices);
    ({ cursor } = next);
  }
  return { feed: first.feed, choices, picks: first.picks };
};

/**
 * Sets the places of the shared connection `connectionId` its sync `feed`
 * reads to `places`, the whole set, as one of the company's admins picked
 * them from `from`, the picks their page started from. Connect checks the
 * connection and the places, refuses (`sync.picks_changed`) when the
 * picks held are no longer `from`, and records the change in the audit
 * log.
 */
export const pickSyncPlaces = async (
  env: Env,
  identity: Identity,
  person: () => Promise<ConnectionPerson>,
  request: unknown
): Promise<void> => {
  const asked: unknown =
    typeof request === "object" && request !== null && "connectionId" in request
      ? request.connectionId
      : undefined;
  await requireCompanyAdmin(env, identity, asked);
  const { connectionId, feed, from, places } = syncErrors.parse(
    "sync.invalid",
    pickSchema,
    request
  );
  await env.CONNECT.pickSyncPlaces({
    person: await person(),
    connectionId,
    feed,
    from,
    places,
  });
};
