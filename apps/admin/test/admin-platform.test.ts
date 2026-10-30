import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { platformData, staffEvents } from "../src/admin/platform-data.ts";
import { eventWords, needWords } from "../src/admin/platform-parts.tsx";
import {
  companiesOf,
  goingOut,
  nextRing,
  platformCounts,
  ringsOf,
  spreadOf,
} from "../src/admin/platform.ts";
import { clientGrid } from "../src/clients/grid.ts";
import type { GridRow, LiveStatus } from "../src/clients/grid.ts";
import { adminDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  clientProvisions,
  clients,
  hostingDestinations,
  rollouts,
  rolloutTargets,
} from "../src/db/schema.ts";
import { importReleases } from "../src/releases/import.ts";
import type { ReleaseSummary } from "../src/releases/queries.ts";
import type { RolloutSummary, TargetView } from "../src/rollout/queries.ts";
import { publishRelease } from "./releases.ts";

const db = adminDatabase(env.DB);
const day = (n: number) => new Date(Date.UTC(2026, 9, n));
/** `ms` past a moment after any event a test makes now, so its events are the latest. */
const later = (ms: number) => new Date(Date.UTC(2099, 0, 1) + ms);

const summary = (
  id: string,
  status: RolloutSummary["status"],
  ring = 0
): RolloutSummary => ({
  id,
  kind: "release",
  releaseId: "r1",
  release: { notes: "feat(core): r1", versionMajor: 1, versionMinor: 0 },
  status,
  ring,
  startedBy: "ops@grasp.test",
  createdAt: day(1),
});

const target = (
  clientId: string,
  ring: number,
  status: TargetView["status"]
): TargetView => ({
  clientId,
  ring,
  status,
  error: null,
  updatedAt: day(1),
});

const release = (id: string, built: number): ReleaseSummary => ({
  id,
  commitSha: id,
  notes: `feat(core): ${id}`,
  builtAt: day(built),
  importedAt: day(built),
  versionMajor: built,
  versionMinor: 0,
});

const row = (id: string, input: Partial<GridRow> = {}): GridRow => ({
  id,
  name: id,
  status: "active",
  ring: 1,
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
  it("shows the rollout going out, or else the latest", () => {
    expect(goingOut([summary("a", "done"), summary("b", "waiting")])?.id).toBe(
      "b"
    );
    expect(
      goingOut([summary("a", "cancelled"), summary("b", "done")])?.id
    ).toBe("a");
    expect(goingOut([])).toBeNull();
  });

  it("takes a rollout ring by ring, the ring after the one it waits after waiting for approval", () => {
    const targets = [
      target("acme", 0, "done"),
      target("beta", 1, "pending"),
      target("gamma", 3, "pending"),
    ];
    const waiting = summary("w", "waiting", 0);

    expect(nextRing(waiting, targets)).toBe(1);
    expect(
      ringsOf(waiting, targets).map(({ ring, state, done, waiting: left }) => ({
        ring,
        state,
        done,
        left,
      }))
    ).toStrictEqual([
      { ring: 0, state: "done", done: 1, left: 0 },
      { ring: 1, state: "waiting", done: 0, left: 1 },
      { ring: 3, state: "todo", done: 0, left: 1 },
    ]);
    expect(nextRing(summary("r", "running", 1), targets)).toBeNull();
  });

  it("marks a ring failed for a company that failed or was rolled back, and stopped for one a cancel stopped", () => {
    const rings = ringsOf(summary("c", "cancelled", 1), [
      target("acme", 0, "rolled_back"),
      target("beta", 1, "stopped"),
      target("gamma", 1, "skipped"),
      target("delta", 2, "deploying"),
    ]);

    expect(rings.map(({ state }) => state)).toStrictEqual([
      "failed",
      "stopped",
      "todo",
    ]);
  });

  it("marks the ring a rollout failed on as failed while its companies still wait, and done once they were all on it", () => {
    const rings = ringsOf(summary("f", "failed", 1), [
      target("acme", 0, "done"),
      target("beta", 1, "pending"),
      target("gamma", 2, "pending"),
    ]);

    expect(rings.map(({ state }) => state)).toStrictEqual([
      "done",
      "failed",
      "todo",
    ]);
    // Failed after its ring was done, waiting to approve the next: done.
    expect(
      ringsOf(summary("w", "failed", 0), [
        target("acme", 0, "done"),
        target("beta", 1, "pending"),
      ]).map(({ state }) => state)
    ).toStrictEqual(["done", "todo"]);
  });

  it("counts for the sidebar the companies that need a look by what was recorded alone, and a rollout that waits", () => {
    const releases = [release("r1", 1), release("r2", 2), release("r3", 3)];
    const rows = [
      row("fine"),
      row("behind", { release: "r1" }),
      row("failed", {
        lastDeploy: { releaseId: "r3", status: "failed", at: day(3) },
      }),
      row("gone", { status: "offboarded", release: "r1" }),
    ];

    expect(
      platformCounts(rows, releases, [summary("w", "waiting")])
    ).toStrictEqual({ needLook: 2, waiting: true });
    expect(
      platformCounts([row("fine")], releases, [
        summary("d", "done"),
        summary("c", "cancelled"),
      ])
    ).toStrictEqual({ needLook: 0, waiting: false });
  });

  it("says which active companies run each release, the newest first, then the ones the page doesn't list", () => {
    const spread = spreadOf(
      [
        row("acme", { release: "r2" }),
        row("beta", { release: "r3" }),
        row("gone", { release: "r3", status: "offboarded" }),
        row("ancient", { release: "r0" }),
        row("new", { release: null, status: "provisioning" }),
      ],
      [release("r2", 2), release("r3", 3), release("r1", 1)]
    );

    expect(
      spread.map(({ releaseId, release: listed, clientIds }) => ({
        releaseId,
        listed: listed !== null,
        clientIds,
      }))
    ).toStrictEqual([
      { releaseId: "r3", listed: true, clientIds: ["beta"] },
      { releaseId: "r2", listed: true, clientIds: ["acme"] },
      { releaseId: "r1", listed: true, clientIds: [] },
      { releaseId: "r0", listed: false, clientIds: ["ancient"] },
    ]);
  });

  it("lists the companies that need a look first: a failed deploy, drift, or two releases behind unpinned, older than every listed one included; one not read never as healthy", () => {
    const releases = [release("r1", 1), release("r2", 2), release("r3", 3)];
    const companies = companiesOf(
      [
        row("zeta"),
        row("failed", {
          lastDeploy: { releaseId: "r3", status: "failed", at: day(3) },
        }),
        row("split"),
        row("behind", { release: "r1" }),
        row("older", { release: "r0" }),
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
        older: live(),
        pinned: live(),
        timedout: live({ drift: "unknown", reach: "unknown" }),
      },
      releases
    );

    expect(
      companies.map(({ row: { id }, standing, needs }) => ({
        id,
        standing,
        needs: needs.map(({ kind }) => kind),
      }))
    ).toStrictEqual([
      { id: "behind", standing: "attention", needs: ["behind"] },
      { id: "failed", standing: "attention", needs: ["failed"] },
      { id: "older", standing: "attention", needs: ["behind"] },
      { id: "split", standing: "attention", needs: ["drift"] },
      { id: "stalled", standing: "attention", needs: ["stopped"] },
      { id: "waiting", standing: "attention", needs: ["not_started"] },
      { id: "new", standing: "setup", needs: [] },
      { id: "timedout", standing: "unread", needs: [] },
      { id: "unread", standing: "unread", needs: [] },
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
        "Not started: no release imported yet.",
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

  it("reads the imported releases, newest first, and the rollout going out with its companies", async () => {
    const older = await publishRelease({ notes: "feat(core): the older one" });
    const newer = await publishRelease({ notes: "feat(core): the newer one" });
    await importReleases(env.RELEASES, db);
    const tag = crypto.randomUUID().slice(0, 8);
    const now = new Date();
    const clientIds = [`acme-${tag}`, `beta-${tag}`];
    await db.insert(clients).values(
      clientIds.map((id, ring) => ({
        id,
        name: id,
        ring,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      }))
    );
    const done = crypto.randomUUID();
    const waiting = crypto.randomUUID();
    await db.insert(rollouts).values([
      {
        id: done,
        kind: "release",
        releaseId: older.id,
        status: "done",
        ring: 1,
        startedBy: "ops@grasp.test",
        createdAt: new Date(now.getTime() - 60_000),
        updatedAt: now,
      },
      {
        id: waiting,
        kind: "release",
        releaseId: newer.id,
        status: "waiting",
        ring: 0,
        startedBy: "ops@grasp.test",
        createdAt: new Date(now.getTime() - 120_000),
        updatedAt: now,
      },
    ]);
    await db.insert(rolloutTargets).values([
      {
        rolloutId: waiting,
        clientId: clientIds[0] ?? "",
        ring: 0,
        status: "done",
        updatedAt: now,
      },
      {
        rolloutId: waiting,
        clientId: clientIds[1] ?? "",
        ring: 1,
        status: "pending",
        updatedAt: now,
      },
    ]);

    const data = await platformData(env);

    expect(data.releases.slice(0, 2).map(({ id }) => id)).toStrictEqual([
      newer.id,
      older.id,
    ]);
    expect({
      id: data.rollout?.id,
      releaseId: data.rollout?.releaseId,
      targets: data.rollout?.targets.map(({ clientId, ring, status }) => ({
        clientId,
        ring,
        status,
      })),
    }).toStrictEqual({
      id: waiting,
      releaseId: newer.id,
      targets: [
        { clientId: clientIds[0], ring: 0, status: "done" },
        { clientId: clientIds[1], ring: 1, status: "pending" },
      ],
    });
  });

  it("lists what staff did to the platform, the latest first, naming each rollout by its release, and none of the admin's own jobs or a deploy's steps", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const shipped = await publishRelease({ notes: "feat(core): shipped" });
    await importReleases(env.RELEASES, db);
    const rolloutId = crypto.randomUUID();
    await db.insert(rollouts).values({
      id: rolloutId,
      kind: "release",
      releaseId: shipped.id,
      status: "waiting",
      ring: 0,
      startedBy: "ops@grasp.test",
      createdAt: later(0),
      updatedAt: later(0),
    });
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
        id: `approve-${tag}`,
        at: later(3),
        actor: "ops@grasp.test",
        action: "rollout.approve",
        target: rolloutId,
      },
      {
        id: `cancel-${tag}`,
        at: later(6),
        actor: "ops@grasp.test",
        action: "rollout.cancel",
        target: `gone-${tag}`,
      },
      {
        id: `system-${tag}`,
        at: later(4),
        actor: "system",
        action: "rollout.approve",
        target: rolloutId,
      },
      {
        id: `deploy-${tag}`,
        at: later(5),
        actor: "ops@grasp.test",
        action: "deploy.start",
        clientId: `acme-${tag}`,
      },
    ]);

    const events = await staffEvents(db);

    expect(
      events
        .slice(0, 3)
        .map((event) => eventWords(event, (id) => id.split("-")[0] ?? id))
    ).toStrictEqual([
      // A rollout the admin no longer has is still a rollout.
      "ops@grasp.test cancelled a rollout",
      `ops@grasp.test approved the next ring of the rollout of ${shipped.id}`,
      "ops@grasp.test pinned acme to r1",
    ]);
    // The admin's own job, even with an action staff take, isn't listed.
    expect(events.map(({ id }) => id)).not.toContain(`system-${tag}`);
  });
});
