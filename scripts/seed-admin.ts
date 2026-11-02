/**
 * `vp run seed:admin [running|done]`: fills the admin's local
 * database (`vp -C apps/admin dev`) with the prototype's sample platform
 * (grasplabs/prototype `data/admin-platform-sample.ts`), so the admin's
 * Platform page shows what the prototype's does: four releases, four
 * companies on Edge, Beta and Stable (one still being provisioned, one
 * whose last deploy failed), and the newest release promoted through Edge
 * and Beta to Stable, its Stable company deploying it or, with `done`,
 * done. Each company is
 * placed in one made-up dedicated destination, its release recorded as
 * its operation (src/hosting/operation.ts) left it: done, failed, or still
 * provisioning.
 *
 * It writes only the admin's local D1, applying its migrations first,
 * through Wrangler's local mode: it never reaches an account. It can run
 * again: each run replaces what the last one wrote, and nothing else.
 * The destination's account is made up, so the page's live reads find
 * none of the companies; the page says so.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const adminDir = path.join(import.meta.dirname, "../apps/admin");

const mode = process.argv[2] ?? "running";
if (mode !== "running" && mode !== "done") {
  throw new Error("Usage: vp run seed:admin [running|done]");
}

/** A day of October 2026 at `time`, as the admin stores it: ms since the epoch. */
const at = (day: number, time = "08:00"): number =>
  Date.parse(`2026-10-${String(day).padStart(2, "0")}T${time}:00Z`);

const releases = [
  {
    id: "26.10.4",
    commit: "3f9c2ab000000000000000000000000000000000",
    day: 14,
    notes: "feat(core): draw workflows left to right",
  },
  {
    id: "26.10.3",
    commit: "91d0e47000000000000000000000000000000000",
    day: 7,
    notes: "feat(core): answer with where the brain read it",
  },
  {
    id: "26.09.12",
    commit: "c27b18f000000000000000000000000000000000",
    day: 0,
    notes: "feat(core): sign in with Google Workspace",
  },
  {
    id: "26.09.11",
    commit: "0a6e5d3000000000000000000000000000000000",
    day: -7,
    notes: "feat(connect): run connect as a Worker of its own",
  },
];

/** A day `day` of October, or the last days of September for those before the 1st. */
const releaseAt = (day: number): number =>
  day >= 1 ? at(day) : Date.parse("2026-09-30T08:00:00Z") + day * 86_400_000;

const companies = [
  {
    id: "hartog",
    name: "Hartog Groothandel",
    channel: "edge",
    status: "active",
    release: "26.10.4",
    // Its last change, its settings and new secrets, failed at its probe.
    lastDeploy: { status: "failed", kind: "settings_and_secrets", day: 15 },
  },
  {
    id: "noordkade",
    name: "Noordkade Finance",
    channel: "beta",
    status: "active",
    release: "26.10.4",
    lastDeploy: { status: "done", kind: "release", day: 14 },
  },
  {
    id: "veldkamp",
    name: "Veldkamp Installatietechniek",
    channel: "stable",
    status: "active",
    release: "26.10.3",
    lastDeploy: { status: "done", kind: "release", day: 9 },
  },
  {
    id: "vanrijn",
    name: "Van Rijn Advocaten",
    channel: "stable",
    status: "provisioning",
    release: null,
    lastDeploy: null,
  },
] as const;

/** The release a company still being provisioned is provisioned with. */
const provisioning = "26.10.4";

/** The made-up dedicated destination every company is placed in. */
const destinationId = "seed-eu-dedicated";

const staff = "nick@grasp.test";

/** The newest release, on every channel: the one promoted through them. */
const promoted = "26.10.4";

const sqlString = (value: string | null): string =>
  value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

const row = (values: (string | number | null)[]): string =>
  `(${values
    .map((value) =>
      typeof value === "number" ? String(value) : sqlString(value)
    )
    .join(", ")})`;

// The seed's own companies: each has one operation and one placement,
// which the seed replaces.
const companyIds = companies.map(({ id }) => sqlString(id)).join(", ");

const statements = [
  // What the last run wrote, children first.
  `DELETE FROM audit_events WHERE id LIKE 'seed-%'`,
  `DELETE FROM client_deploys WHERE client_id IN (${companyIds})`,
  `DELETE FROM channels`,
  `DELETE FROM client_provisions WHERE client_id IN (${companyIds})`,
  `DELETE FROM client_placements WHERE client_id IN (${companyIds})`,
  // The companies, releases and workers in place, as anything else a local
  // admin made of them (another rollout's targets, say) may name them.
  `INSERT INTO releases (id, commit_sha, manifest, manifest_sha256, built_at, imported_at) VALUES ${releases
    .map(({ id, commit, day, notes }) =>
      row([
        id,
        commit,
        JSON.stringify({ notes }),
        "0".repeat(64),
        releaseAt(day),
        releaseAt(day),
      ])
    )
    .join(
      ", "
    )} ON CONFLICT(id) DO UPDATE SET commit_sha = excluded.commit_sha, manifest = excluded.manifest, manifest_sha256 = excluded.manifest_sha256, built_at = excluded.built_at, imported_at = excluded.imported_at`,
  `INSERT INTO hosting_destinations (id, kind, account_id, namespace, policies, capabilities, created_at, updated_at) VALUES ${row(
    [
      destinationId,
      "dedicated",
      "seed-account",
      null,
      JSON.stringify(["eu-storage"]),
      JSON.stringify({}),
      at(1),
      at(1),
    ]
  )} ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, account_id = excluded.account_id, namespace = excluded.namespace, policies = excluded.policies, capabilities = excluded.capabilities, updated_at = excluded.updated_at`,
  `INSERT INTO clients (id, name, channel, status, created_by, created_at, updated_at) VALUES ${companies
    .map(({ id, name, channel, status }) =>
      row([id, name, channel, status, staff, at(1), at(1)])
    )
    .join(
      ", "
    )} ON CONFLICT(id) DO UPDATE SET name = excluded.name, channel = excluded.channel, status = excluded.status, created_by = excluded.created_by, created_at = excluded.created_at, updated_at = excluded.updated_at, generation = 1, rotated_at = NULL, rotation_live_at = NULL, sign_in = NULL, config_changed_at = NULL, pinned_release_id = NULL`,
  `INSERT INTO client_placements (client_id, deployment_id, destination_id, policy_id, placed_by, placed_at) VALUES ${companies
    .map(({ id }) =>
      row([id, `seed${id}`, destinationId, "eu-storage", staff, at(1)])
    )
    .join(", ")}`,
  ...companies.flatMap(({ id, release }) =>
    release === null
      ? []
      : [
          `INSERT INTO client_workers (client_id, worker, script_name, release_id, version_id, deployed_at) VALUES ${[
            "core",
            "connect",
          ]
            .map((worker) =>
              row([
                id,
                worker,
                `grasp-${worker}`,
                release,
                `${worker}-${release}`,
                at(14),
              ])
            )
            .join(
              ", "
            )} ON CONFLICT(client_id, worker) DO UPDATE SET script_name = excluded.script_name, release_id = excluded.release_id, version_id = excluded.version_id, deployed_at = excluded.deployed_at`,
        ]
  ),
  // Each company's operation, as it left the company: its last change
  // done or failed, or, still being provisioned, at its migrations.
  `INSERT INTO client_provisions (id, client_id, release_id, status, step, error, change, what, run_id, started_by, created_at, updated_at) VALUES ${companies
    .map(({ id, release, lastDeploy }) => {
      if (lastDeploy === null || release === null) {
        return row([
          `seed-operation-${id}`,
          id,
          provisioning,
          "running",
          "migrations",
          null,
          1,
          "release",
          `seed-run-${id}`,
          staff,
          at(1),
          at(1, "08:10"),
        ]);
      }
      const failed = lastDeploy.status === "failed";
      return row([
        `seed-operation-${id}`,
        id,
        release,
        lastDeploy.status,
        failed ? "secrets" : "route",
        failed ? "probe_unanswered" : null,
        2,
        lastDeploy.kind,
        `seed-run-${id}`,
        staff,
        at(lastDeploy.day),
        at(lastDeploy.day, "08:10"),
      ]);
    })
    .join(", ")}`,
  `INSERT INTO channels (id, release_id, updated_at) VALUES ${[
    "edge",
    "beta",
    "stable",
  ]
    .map((channel) => row([channel, promoted, at(14)]))
    .join(", ")}`,
  `INSERT INTO client_deploys (client_id, release_id, run_id, status, error, started_at, ended_at) VALUES ${row(
    [
      "veldkamp",
      promoted,
      "seed-deploy-veldkamp",
      mode === "running" ? "deploying" : "done",
      null,
      at(14, "09:00"),
      mode === "running" ? null : at(14, "09:10"),
    ]
  )}`,
  `INSERT INTO audit_events (id, at, actor, action, client_id, target, detail) VALUES ${[
    row([
      "seed-promote-edge",
      at(13),
      "system",
      "channel.promote",
      null,
      promoted,
      JSON.stringify({ channel: "edge", back: false }),
    ]),
    row([
      "seed-promote-beta",
      at(13, "12:00"),
      staff,
      "channel.promote",
      null,
      promoted,
      JSON.stringify({ channel: "beta", back: false }),
    ]),
    row([
      "seed-promote-stable",
      at(14),
      staff,
      "channel.promote",
      null,
      promoted,
      JSON.stringify({ channel: "stable", back: false }),
    ]),
    row([
      "seed-channel",
      at(12),
      staff,
      "client.channel",
      "veldkamp",
      null,
      JSON.stringify({ channel: "stable" }),
    ]),
    row(["seed-create", at(1), staff, "client.create", "vanrijn", null, null]),
  ].join(", ")}`,
];

/** Runs Wrangler in the admin's folder, in its local mode; throws if it fails. */
const wrangler = (args: string[]): void => {
  // The admin's own Wrangler, whatever is on PATH.
  const result = spawnSync(
    path.join(adminDir, "node_modules/.bin/wrangler"),
    args,
    {
      cwd: adminDir,
      stdio: "inherit",
    }
  );
  if (result.status !== 0) {
    const how =
      result.error?.message ??
      (result.signal === null
        ? `exit status ${String(result.status)}`
        : `signal ${result.signal}`);
    throw new Error(`wrangler ${args.join(" ")} failed: ${how}`, {
      cause: result.error,
    });
  }
};

wrangler(["d1", "migrations", "apply", "DB", "--local"]);
const dir = mkdtempSync(path.join(tmpdir(), "seed-admin-"));
try {
  const file = path.join(dir, "seed.sql");
  writeFileSync(file, `${statements.join(";\n")};\n`);
  wrangler(["d1", "execute", "DB", "--local", `--file=${file}`]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Seeded the admin's local platform, its rollout ${mode}.`);
