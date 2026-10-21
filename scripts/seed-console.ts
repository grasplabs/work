/**
 * `vp run seed:console [waiting|running]`: fills the console's local
 * database (`vp -C apps/console dev`) with the prototype's sample platform
 * (grasplabs/prototype `data/admin-platform-sample.ts`), so the admin's
 * Platform page shows what the prototype's does: four releases, four
 * companies on rings 0 to 2 (one still being provisioned, one whose last
 * deploy failed), and the rollout of the newest release, waiting for
 * approval of ring 2 or, with `running`, rolling it out.
 *
 * It writes only the console's local D1, applying its migrations first,
 * through Wrangler's local mode: it never reaches an account. It can run
 * again: each run replaces what the last one wrote, and nothing else.
 * Every company's account is made up, so the page's live reads find none
 * of them; the page says so.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const consoleDir = path.join(import.meta.dirname, "../apps/console");

const mode = process.argv[2] ?? "waiting";
if (mode !== "waiting" && mode !== "running") {
  throw new Error("Usage: vp run seed:console [waiting|running]");
}

/** A day of October 2026 at `time`, as the console stores it: ms since the epoch. */
const at = (day: number, time = "08:00"): number =>
  Date.parse(`2026-10-${String(day).padStart(2, "0")}T${time}:00Z`);

const releases = [
  {
    id: "r000418-3f9c2ab",
    day: 14,
    notes: "feat(core): draw workflows left to right",
  },
  {
    id: "r000412-91d0e47",
    day: 7,
    notes: "feat(core): answer with where the brain read it",
  },
  {
    id: "r000405-c27b18f",
    day: 0,
    notes: "feat(core): sign in with Google Workspace",
  },
  {
    id: "r000399-0a6e5d3",
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
    ring: 0,
    status: "active",
    release: "r000418-3f9c2ab",
    // Its last deploy, of its settings and new secrets, failed.
    lastDeploy: { status: "failed", kind: "settings_and_secrets", day: 15 },
  },
  {
    id: "noordkade",
    name: "Noordkade Finance",
    ring: 1,
    status: "active",
    release: "r000418-3f9c2ab",
    lastDeploy: { status: "done", kind: "release", day: 14 },
  },
  {
    id: "veldkamp",
    name: "Veldkamp Installatietechniek",
    ring: 2,
    status: "active",
    release: "r000412-91d0e47",
    lastDeploy: { status: "done", kind: "release", day: 9 },
  },
  {
    id: "vanrijn",
    name: "Van Rijn Advocaten",
    ring: 2,
    status: "provisioning",
    release: null,
    lastDeploy: null,
  },
] as const;

const staff = "nick@grasp.test";
const rolloutId = "00000000-0000-4000-8000-000000000418";

const sqlString = (value: string | null): string =>
  value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

const row = (values: (string | number | null)[]): string =>
  `(${values
    .map((value) =>
      typeof value === "number" ? String(value) : sqlString(value)
    )
    .join(", ")})`;

const ids = companies.map(({ id }) => sqlString(id)).join(", ");
// Only the deploys the seed wrote: anything else a local console deployed
// for these companies, and the rollouts that name it, stay.
const deployIds = companies
  .map(({ id }) => sqlString(`seed-deploy-${id}`))
  .join(", ");

const statements = [
  // What the last run wrote, children first.
  `DELETE FROM audit_events WHERE id LIKE 'seed-%'`,
  `DELETE FROM rollout_targets WHERE rollout_id = ${sqlString(rolloutId)}`,
  `DELETE FROM rollouts WHERE id = ${sqlString(rolloutId)}`,
  `DELETE FROM client_deploys WHERE id IN (${deployIds})`,
  `DELETE FROM client_workers WHERE client_id IN (${ids})`,
  // The companies and releases in place, as anything else a local console
  // made of them (another rollout's targets, say) may name them.
  `INSERT INTO releases (id, commit_sha, manifest, manifest_sha256, built_at, imported_at) VALUES ${releases
    .map(({ id, day, notes }) =>
      row([
        id,
        id.split("-")[1] ?? id,
        JSON.stringify({ notes }),
        "0".repeat(64),
        releaseAt(day),
        releaseAt(day),
      ])
    )
    .join(
      ", "
    )} ON CONFLICT(id) DO UPDATE SET commit_sha = excluded.commit_sha, manifest = excluded.manifest, manifest_sha256 = excluded.manifest_sha256, built_at = excluded.built_at, imported_at = excluded.imported_at`,
  `INSERT INTO clients (id, name, account_id, ring, status, created_by, created_at, updated_at) VALUES ${companies
    .map(({ id, name, ring, status }) =>
      row([id, name, `seed-account-${id}`, ring, status, staff, at(1), at(1)])
    )
    .join(
      ", "
    )} ON CONFLICT(id) DO UPDATE SET name = excluded.name, account_id = excluded.account_id, ring = excluded.ring, status = excluded.status, created_by = excluded.created_by, created_at = excluded.created_at, updated_at = excluded.updated_at, generation = 1, rotated_at = NULL, rotation_live_at = NULL, workers_subdomain = NULL, sign_in = NULL, config_changed_at = NULL, pinned_release_id = NULL`,
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
            .join(", ")}`,
        ]
  ),
  ...companies.flatMap(({ id, release, lastDeploy }) =>
    lastDeploy === null || release === null
      ? []
      : [
          `INSERT INTO client_deploys (id, client_id, release_id, kind, status, step, error, started_by, created_at, updated_at) VALUES ${row(
            [
              `seed-deploy-${id}`,
              id,
              release,
              lastDeploy.kind,
              lastDeploy.status,
              lastDeploy.status === "failed" ? "workers" : "router",
              lastDeploy.status === "failed" ? "smoke_check_failed" : null,
              staff,
              at(lastDeploy.day),
              at(lastDeploy.day, "08:10"),
            ]
          )}`,
        ]
  ),
  `INSERT INTO rollouts (id, kind, release_id, status, ring, started_by, created_at, updated_at) VALUES ${row(
    [
      rolloutId,
      "release",
      "r000418-3f9c2ab",
      mode,
      mode === "running" ? 2 : 1,
      staff,
      at(14),
      at(14, "09:00"),
    ]
  )}`,
  `INSERT INTO rollout_targets (rollout_id, client_id, ring, status, updated_at) VALUES ${[
    row([rolloutId, "hartog", 0, "done", at(14)]),
    row([rolloutId, "noordkade", 1, "done", at(14)]),
    row([
      rolloutId,
      "veldkamp",
      2,
      mode === "running" ? "deploying" : "pending",
      at(14),
    ]),
  ].join(", ")}`,
  `INSERT INTO audit_events (id, at, actor, action, client_id, target, detail) VALUES ${[
    row(["seed-start", at(14), staff, "rollout.start", null, rolloutId, null]),
    row([
      "seed-approve",
      at(14, "08:30"),
      staff,
      "rollout.approve",
      null,
      rolloutId,
      JSON.stringify({ ring: 1 }),
    ]),
    row([
      "seed-ring",
      at(12),
      staff,
      "client.ring",
      "veldkamp",
      null,
      JSON.stringify({ ring: 2 }),
    ]),
    row(["seed-create", at(1), staff, "client.create", "vanrijn", null, null]),
  ].join(", ")}`,
];

/** Runs Wrangler in the console's folder, in its local mode; throws if it fails. */
const wrangler = (args: string[]): void => {
  // The console's own Wrangler, whatever is on PATH.
  const result = spawnSync(
    path.join(consoleDir, "node_modules/.bin/wrangler"),
    args,
    {
      cwd: consoleDir,
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
const dir = mkdtempSync(path.join(tmpdir(), "seed-console-"));
try {
  const file = path.join(dir, "seed.sql");
  writeFileSync(file, `${statements.join(";\n")};\n`);
  wrangler(["d1", "execute", "DB", "--local", `--file=${file}`]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`Seeded the console's local platform, its rollout ${mode}.`);
