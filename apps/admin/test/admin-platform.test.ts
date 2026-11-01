import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { platformData, staffEvents } from "../src/admin/platform-data.ts";
import { eventWords, needWords } from "../src/admin/platform-parts.tsx";
import { companiesOf, platformCounts } from "../src/admin/platform.ts";
import { clientGrid } from "../src/clients/grid.ts";
import type { GridRow, LiveStatus } from "../src/clients/grid.ts";
import { adminDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  channels,
  clientProvisions,
  clients,
  hostingDestinations,
} from "../src/db/schema.ts";
import { importReleases } from "../src/releases/import.ts";
import { promoteRelease, releaseToEdge } from "../src/rollout/channels.ts";
import { staff } from "./hosting.ts";
import { publishRelease } from "./releases.ts";

const db = adminDatabase(env.DB);
const day = (n: number) => new Date(Date.UTC(2026, 9, n));
/** `ms` past a moment after any event a test makes now, so its events are the latest. */
const later = (ms: number) => new Date(Date.UTC(2099, 0, 1) + ms);

const row = (id: string, input: Partial<GridRow> = {}): GridRow => ({
  id,
  name: id,
  status: "active",
  channel: "stable",
  hostname: null,
  release: "r3",
  pinnedReleaseId: null,
  lastDeploy: null,
  setup: null,
  ...input,
});

const live = (input: Partial<LiveStatus> = {}): LiveStatus => ({
  drift: "in_sync",
  sharedSecretsCurrent: true,
  reach: "reachable",
  onboarding: null,
  ...input,
});

describe("the Platform page's model", () => {
  it("counts for the sidebar the companies that need a look by what was recorded alone", () => {
    const rows = [
      row("fine"),
      // Behind its channel is the channel's to show, not a company's need.
      row("behind", { release: "r1" }),
      row("failed", {
        lastDeploy: { releaseId: "r3", status: "failed", at: day(3) },
      }),
      row("gone", {
        status: "offboarded",
        lastDeploy: { releaseId: "r3", status: "failed", at: day(3) },
      }),
    ];

    expect({
      some: platformCounts(rows),
      none: platformCounts([row("fine")]),
    }).toStrictEqual({ some: { needLook: 1 }, none: { needLook: 0 } });
  });

  it("lists the companies that need a look first: a failed deploy, drift, or setting up that waits; one not read never as healthy", () => {
    const companies = companiesOf(
      [
        row("zeta"),
        row("failed", {
          lastDeploy: { releaseId: "r3", status: "failed", at: day(3) },
        }),
        row("split"),
        row("behind", { release: "r1" }),
        row("pinned", { release: "r1", pinnedReleaseId: "r1" }),
        row("new", { status: "provisioning", release: null }),
        row("waiting", {
          status: "provisioning",
          release: null,
          setup: { state: "not_started", why: "no_release" },
        }),
        row("stalled", {
          status: "provisioning",
          release: null,
          lastDeploy: { releaseId: "r3", status: "running", at: day(3) },
          setup: { state: "stopped" },
        }),
        row("unread"),
        row("timedout"),
        row("gone", { status: "offboarded", release: "r1" }),
      ],
      {
        zeta: live(),
        failed: live(),
        split: live({ drift: "split" }),
        behind: live(),
        pinned: live(),
        timedout: live({ drift: "unknown", reach: "unknown" }),
      }
    );

    expect(
      companies.map(({ row: { id }, standing, needs }) => ({
        id,
        standing,
        needs: needs.map(({ kind }) => kind),
      }))
    ).toStrictEqual([
      { id: "failed", standing: "attention", needs: ["failed"] },
      { id: "split", standing: "attention", needs: ["drift"] },
      { id: "stalled", standing: "attention", needs: ["stopped"] },
      { id: "waiting", standing: "attention", needs: ["not_started"] },
      { id: "new", standing: "setup", needs: [] },
      { id: "timedout", standing: "unread", needs: [] },
      { id: "unread", standing: "unread", needs: [] },
      { id: "behind", standing: "healthy", needs: [] },
      { id: "pinned", standing: "healthy", needs: [] },
      { id: "zeta", standing: "healthy", needs: [] },
      { id: "gone", standing: "offboarded", needs: [] },
    ]);
  });
});

describe("a company being set up, on the grid", () => {
  it("says it hasn't started and why, or that it stopped, each with the next step", async () => {
    const id = `setup-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    await db.update(hostingDestinations).set({ accountId: null });
    await db
      .insert(clients)
      .values({ id, name: id, createdAt: now, updatedAt: now });

    const grid = await clientGrid(env);
    const setup = grid.find((each) => each.id === id)?.setup;
    const words = [
      needWords({ kind: "not_started", why: "no_destination" }),
      needWords({ kind: "not_started", why: "no_release" }),
      needWords({ kind: "not_started", why: null }),
      needWords({ kind: "stopped" }),
      needWords({ kind: "needs_attention", reason: "stuck" }),
      needWords({ kind: "needs_attention", reason: "needs_person" }),
    ];

    expect({ setup, words }).toStrictEqual({
      setup: { state: "not_started", why: "no_destination" },
      words: [
        "Not started: no hosting destination ready.",
        "Not started: promote a release to its channel first.",
        "Not started: provision it from its Setup.",
        "Stopped: Grasp is retrying it by itself.",
        "Needs attention: Grasp's automatic retries haven't finished setting it up. Retry now from its Setup once it's fixed.",
        "Needs attention: setting it up stopped for something Grasp can't fix by itself. Retry now from its Setup once it's fixed.",
      ],
    });
  });
});

describe("a company whose setting up can't be read now, on the grid", () => {
  it("shows its status as unavailable, and every other company as it is", async () => {
    const now = new Date();
    const published = await publishRelease({ notes: "feat(core): grid" });
    const releaseId = published.id;
    await importReleases(env.RELEASES, db);
    const unreadable = `unread-${crypto.randomUUID().slice(0, 8)}`;
    const fine = `fine-${crypto.randomUUID().slice(0, 8)}`;
    for (const id of [unreadable, fine]) {
      // oxlint-disable-next-line no-await-in-loop -- two companies
      await db
        .insert(clients)
        .values({ id, name: id, createdAt: now, updatedAt: now });
      // oxlint-disable-next-line no-await-in-loop -- two companies
      await db.insert(clientProvisions).values({
        id: crypto.randomUUID(),
        clientId: id,
        releaseId,
        status: "running",
        startedBy: "staff@grasp.test",
        createdAt: now,
        updatedAt: now,
      });
    }
    // A runner the admin has no workflow for: reading its run throws, as
    // an engine that answers with an error does. The other has none: gone.
    await env.DB.prepare(
      "INSERT INTO client_runs (client_id, run_id, claimed_at, kind) VALUES (?, ?, ?, ?)"
    )
      .bind(unreadable, `${unreadable}-p1`, now.getTime(), "unknown_kind")
      .run();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const grid = await clientGrid(env);
    warned.mockRestore();
    const setupOf = (id: string) => grid.find((each) => each.id === id)?.setup;

    expect({
      unreadable: setupOf(unreadable),
      fine: setupOf(fine),
      words: needWords({ kind: "setup_unread" }),
    }).toStrictEqual({
      unreadable: { state: "unread" },
      fine: { state: "stopped" },
      words:
        "Being set up: status unavailable just now. Its Setup reads it again.",
    });
  });
});

describe("the Platform page's data", () => {
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("reads each channel's release, Edge first, and every change of one, the latest first", async () => {
    const older = await publishRelease({ notes: "feat(core): the older one" });
    const newer = await publishRelease({ notes: "feat(core): the newer one" });
    await importReleases(env.RELEASES, db);
    await db.delete(channels);
    await releaseToEdge(env, [older.id]);
    await promoteRelease(env, staff, { channel: "beta", releaseId: older.id });
    await releaseToEdge(env, [newer.id]);

    const data = await platformData(env);

    expect({
      channels: data.channels.map(({ channel, releaseId, notes }) => ({
        channel,
        releaseId,
        notes,
      })),
      history: data.history
        .slice(0, 3)
        .map(({ channel, releaseId, actor }) => ({
          channel,
          releaseId,
          actor,
        })),
    }).toStrictEqual({
      channels: [
        {
          channel: "edge",
          releaseId: newer.id,
          notes: "feat(core): the newer one",
        },
        {
          channel: "beta",
          releaseId: older.id,
          notes: "feat(core): the older one",
        },
        { channel: "stable", releaseId: null, notes: "" },
      ],
      history: [
        { channel: "edge", releaseId: newer.id, actor: "system" },
        { channel: "beta", releaseId: older.id, actor: staff.email },
        { channel: "edge", releaseId: older.id, actor: "system" },
      ],
    });
  });

  it("lists what staff did to the platform, the latest first, and none of the admin's own jobs or a deploy's steps", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    await db.insert(auditEvents).values([
      {
        id: `pin-${tag}`,
        at: later(2),
        actor: "ops@grasp.test",
        action: "client.pin",
        clientId: `acme-${tag}`,
        target: "r1",
      },
      {
        id: `promote-${tag}`,
        at: later(3),
        actor: "ops@grasp.test",
        action: "channel.promote",
        target: "r2",
        detail: JSON.stringify({ channel: "beta" }),
      },
      {
        id: `system-${tag}`,
        at: later(4),
        actor: "system",
        action: "channel.promote",
        target: "r3",
        detail: JSON.stringify({ channel: "edge" }),
      },
      {
        id: `deploy-${tag}`,
        at: later(5),
        actor: "ops@grasp.test",
        action: "deploy.start",
        clientId: `acme-${tag}`,
      },
      {
        id: `secrets-${tag}`,
        at: later(6),
        actor: "ops@grasp.test",
        action: "secrets.roll_out",
      },
    ]);

    const events = await staffEvents(db);

    expect({
      words: events
        .slice(0, 3)
        .map((event) => eventWords(event, (id) => id.split("-")[0] ?? id)),
      // The admin's own job, even with an action staff take, isn't listed.
      system: events.some(({ id }) => id === `system-${tag}`),
    }).toStrictEqual({
      words: [
        "ops@grasp.test rolled out the shared secrets",
        "ops@grasp.test set a channel to r2",
        "ops@grasp.test pinned acme to r1",
      ],
      system: false,
    });
  });
});
