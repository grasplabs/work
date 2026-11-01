import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { act, actIfChanged, adminDatabase } from "../src/db/act.ts";
import { auditEvents, clientAdminReads, clients } from "../src/db/schema.ts";
import type { Channel } from "../src/db/schema.ts";

const db = adminDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/** A new client's row, with a unique slug. */
const newClient = () => {
  const id = `client-${crypto.randomUUID()}`;
  const now = new Date();
  return {
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
  };
};

const eventsFor = async (clientId: string) =>
  await db.select().from(auditEvents).where(eq(auditEvents.clientId, clientId));

describe(act, () => {
  it("writes the change and its audit event together", async () => {
    const client = newClient();

    await act(db, staff, [db.insert(clients).values(client)], {
      action: "client.create",
      clientId: client.id,
      target: "eu-dedicated",
      detail: { channel: "stable" },
    });

    const [row] = await db
      .select()
      .from(clients)
      .where(eq(clients.id, client.id));
    expect(row).toMatchObject({ name: client.name, status: "provisioning" });
    const events = await eventsFor(client.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: staff.email,
      action: "client.create",
      target: "eu-dedicated",
      detail: JSON.stringify({ channel: "stable" }),
    });
    expect(events[0]?.at).toBeInstanceOf(Date);
  });

  it("records the admin's own jobs as the system", async () => {
    const client = newClient();

    await act(db, "system", [db.insert(clients).values(client)], {
      action: "client.create",
      clientId: client.id,
    });

    const events = await eventsFor(client.id);
    expect(
      events.map(({ actor, detail }) => ({ actor, detail }))
    ).toStrictEqual([{ actor: "system", detail: null }]);
  });

  it("writes nothing, the event included, when any statement fails", async () => {
    const taken = newClient();
    await db.insert(clients).values(taken);
    const client = newClient();

    // One slug is one client: a second client of it fails, and takes the
    // first statement and the event with it.
    await expect(
      act(
        db,
        staff,
        [
          db.insert(clients).values(client),
          db.insert(clients).values({ ...newClient(), id: taken.id }),
        ],
        { action: "client.create", clientId: client.id }
      )
    ).rejects.toThrow("UNIQUE constraint failed");

    await expect(
      db.select().from(clients).where(eq(clients.id, client.id))
    ).resolves.toStrictEqual([]);
    await expect(eventsFor(client.id)).resolves.toStrictEqual([]);
  });

  it("refuses a change to a client that doesn't exist", async () => {
    const clientId = `client-${crypto.randomUUID()}`;

    await expect(
      act(
        db,
        staff,
        [db.insert(clientAdminReads).values({ clientId, askedAt: new Date() })],
        { action: "client.read", clientId }
      )
    ).rejects.toThrow("FOREIGN KEY constraint failed");

    await expect(eventsFor(clientId)).resolves.toStrictEqual([]);
  });

  it("refuses an action that isn't a dotted verb, writing nothing", async () => {
    const client = newClient();

    await expect(
      act(db, staff, [db.insert(clients).values(client)], {
        action: "Created a client",
        clientId: client.id,
      })
    ).rejects.toThrow("Not an audit action");

    await expect(
      db.select().from(clients).where(eq(clients.id, client.id))
    ).resolves.toStrictEqual([]);
  });
});

describe(actIfChanged, () => {
  /** Moves `client` to `channel` only while it still follows Stable. */
  const promote = (clientId: string, channel: Channel) =>
    db
      .update(clients)
      .set({ channel })
      .where(and(eq(clients.id, clientId), eq(clients.channel, "stable")));

  it("records a conditional change that happened", async () => {
    const client = newClient();
    await db.insert(clients).values(client);

    await expect(
      actIfChanged(db, staff, promote(client.id, "edge"), {
        action: "client.channel",
        clientId: client.id,
        detail: { channel: "edge" },
      })
    ).resolves.toBeTruthy();

    const events = await eventsFor(client.id);
    expect(events).toMatchObject([
      {
        actor: staff.email,
        action: "client.channel",
        target: null,
        detail: JSON.stringify({ channel: "edge" }),
      },
    ]);
    expect(events[0]?.at).toBeInstanceOf(Date);
  });

  it("records nothing when the change matched no row", async () => {
    const client = newClient();
    await db.insert(clients).values({ ...client, channel: "beta" });

    await expect(
      actIfChanged(db, staff, promote(client.id, "edge"), {
        action: "client.channel",
        clientId: client.id,
      })
    ).resolves.toBeFalsy();

    await expect(eventsFor(client.id)).resolves.toStrictEqual([]);
    const [row] = await db
      .select({ channel: clients.channel })
      .from(clients)
      .where(eq(clients.id, client.id));
    expect(row).toStrictEqual({ channel: "beta" });
  });

  it("records one change once, when two race for it", async () => {
    const client = newClient();
    await db.insert(clients).values(client);

    const results = await Promise.all([
      actIfChanged(db, staff, promote(client.id, "edge"), {
        action: "client.channel",
        clientId: client.id,
      }),
      actIfChanged(db, "system", promote(client.id, "beta"), {
        action: "client.channel",
        clientId: client.id,
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(eventsFor(client.id)).resolves.toHaveLength(1);
  });
});
