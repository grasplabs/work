import type {
  ConnectionPerson,
  SharedSyncPlaces,
} from "@grasp-os/shared/connect";
import { requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { syncErrors, syncPicksSchema } from "@grasp-os/shared/sync";
import { z } from "zod";

// The places of a shared connection an admin picks to sync into the Brain
// (GRA-1758, GRA-1759): its connector's shared drives or SharePoint
// libraries, as connect lists what the connected account can see, and
// which of them are picked. Connect keeps the picks, refuses a read of any
// other place, and audits every change and refusal (apps/connect's
// sync.ts); core lets only the company's own admins ask, never Grasp
// staff, who never decide what a client's connections bring in. Who may
// read what a picked place brings is the connection's Brain audience
// (connection-audiences.ts), not the source's permissions.

const connectionIdSchema = z.string().min(1).max(128);

const pickSchema = z.strictObject({
  connectionId: connectionIdSchema,
  feed: z.string().regex(/^[a-z][a-z\d-]{0,63}$/u),
  places: syncPicksSchema,
});

/** Refuses anyone but one of the company's own admins: never Grasp staff. */
const requireCompanyAdmin = (identity: Identity): void => {
  requireAdmin(identity);
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
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
  requireCompanyAdmin(identity);
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
  return { feed: first.feed, choices };
};

/**
 * Sets the places of the shared connection `connectionId` its sync `feed`
 * reads to `places`, the whole set, as one of the company's admins picked
 * them. Connect checks the connection and the places, and records the
 * change in the audit log.
 */
export const pickSyncPlaces = async (
  env: Env,
  identity: Identity,
  person: () => Promise<ConnectionPerson>,
  request: unknown
): Promise<void> => {
  requireCompanyAdmin(identity);
  const { connectionId, feed, places } = syncErrors.parse(
    "sync.invalid",
    pickSchema,
    request
  );
  await env.CONNECT.pickSyncPlaces({
    person: await person(),
    connectionId,
    feed,
    places,
  });
};
