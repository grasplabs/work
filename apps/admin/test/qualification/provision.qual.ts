import { releaseManifestSchema } from "@grasp-os/shared/release";
/* oxlint-disable eslint/no-nested-ternary, typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, unicorn/no-await-expression-member, eslint/no-plusplus, eslint/no-await-in-loop, react-hooks/rules-of-hooks -- a hand-run qualification harness (GRA-430), never in CI or production: kept as it ran, for the record. */
/**
 * Real-account qualification (GRA-430), part 3: two test clients provisioned
 * on ordinary Workers by the admin's own code (`placeAndProvision`), from
 * a release built from main (scripts/release), into the account the relay
 * reaches. Each client's deployment id carries the run's prefix, so every
 * resource it gets is `g<prefix>-<a|b>-…`. Prints what each operation
 * recorded; the attacks run against the result separately.
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  clientPlacements,
  clientProvisions,
  clientResources,
  clients,
  releases,
} from "../../src/db/schema.ts";
import { placeClient, saveDestination } from "../../src/hosting/inventory.ts";
import { placeAndProvision } from "../../src/hosting/placement.ts";
import { importReleases } from "../../src/releases/import.ts";
import { currentRun, hasEnded } from "../../src/runners.ts";
import { db, staff, verified } from "../hosting.ts";
import { useStoreSecrets } from "../secrets-store.ts";

const qual = env as unknown as {
  QUAL_VARIANT: string;
  QUAL_ACCOUNT_ID: string;
  QUAL_PREFIX: string;
};
const prefix = qual.QUAL_PREFIX;
const releaseOrigin = "https://qual-release.invalid";

// The proxy replaces the token with the real one.
useStoreSecrets({ deployer: "placeholder", tenant: "placeholder" });

/** The built release, put in the admin's releases bucket as CI publishes it. */
const publishRelease = async (): Promise<string> => {
  const manifestText = await (
    await fetch(`${releaseOrigin}/manifest.json`)
  ).text();
  const manifest = JSON.parse(manifestText) as { releaseId: string };
  const keys = z
    .array(z.string())
    .parse(await (await fetch(`${releaseOrigin}/__list`)).json());
  for (const key of keys) {
    // oxlint-disable-next-line no-await-in-loop -- a few hundred, in order
    const response = await fetch(`${releaseOrigin}/${key}`);
    expect(response.status, key).toBe(200);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await env.RELEASES.put(key, await response.arrayBuffer());
  }
  await env.RELEASES.put(
    `releases/${manifest.releaseId}/manifest.json`,
    manifestText
  );
  return manifest.releaseId;
};

/** What the run observed, into the relay's log (workerd writes no files). */
const report = async (label: string, value: unknown): Promise<void> => {
  await fetch(`${releaseOrigin}/__report`, {
    method: "POST",
    body: JSON.stringify({ label, value }),
  });
};

const waitForRun = async (clientId: string): Promise<void> => {
  for (let i = 0; i < 360; i++) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    const run = await currentRun(env, clientId);
    if (run !== null && hasEnded(run.status)) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling
    await scheduler.wait(5000);
  }
  throw new Error(`${clientId}'s run didn't end`);
};

const sha256Hex = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * The release the clients are provisioned with: the one built, as the
 * admin's import takes it; when the import refuses it, its manifest
 * recorded directly, as the admin's own tests record theirs. With
 * QUAL_VARIANT=no-ai, the same release without core's Workers AI binding,
 * under an id of its own, which provisioning refuses for placed clients
 * (`model_spend_undecided`).
 */
const releaseToProvision = async (): Promise<string> => {
  const releaseId = await publishRelease();
  const imported = await importReleases(env.RELEASES, db);
  await report("import", imported);
  const builtText = await (
    await fetch(`${releaseOrigin}/manifest.json`)
  ).text();
  const built = releaseManifestSchema.parse(JSON.parse(builtText));
  const variant = qual.QUAL_VARIANT;
  const manifest =
    variant === "no-ai"
      ? {
          ...built,
          releaseId: `${built.releaseId}noai`,
          workers: Object.fromEntries(
            Object.entries(built.workers).map(([name, worker]) => [
              name,
              {
                ...worker,
                bindings: worker.bindings.filter(({ type }) => type !== "ai"),
              },
            ])
          ),
        }
      : built;
  const text = variant === "no-ai" ? JSON.stringify(manifest) : builtText;
  const existing = await db
    .select()
    .from(releases)
    .where(eq(releases.id, manifest.releaseId))
    .get();
  if (existing === undefined) {
    const now = new Date();
    await db.insert(releases).values({
      id: manifest.releaseId,
      commitSha: manifest.commit,
      manifest: text,
      manifestSha256: await sha256Hex(text),
      builtAt: now,
      importedAt: now,
    });
  }
  const row = await db
    .select()
    .from(releases)
    .where(eq(releases.id, manifest.releaseId))
    .get();
  await report("release", {
    variant,
    built: releaseId,
    builtManifestSha256: await sha256Hex(builtText),
    id: row?.id,
    commit: row?.commitSha,
    manifestSha256: row?.manifestSha256,
    recordedBy:
      existing === undefined &&
      variant !== "no-ai" &&
      imported.imported.length === 0
        ? "direct insert (import refused it)"
        : variant === "no-ai"
          ? "direct insert (variant)"
          : "import",
  });
  return manifest.releaseId;
};

it.runIf(Reflect.get(env, "QUAL_PROVISION") === "1")(
  "provisions two clients through placeAndProvision",
  async () => {
    const releaseId = await releaseToProvision();

    const destinationId = `${prefix}-eu`;
    await saveDestination(db, staff, {
      id: destinationId,
      kind: "dedicated",
      accountId: qual.QUAL_ACCOUNT_ID,
      namespace: null,
      policies: ["eu-storage"],
      capabilities: verified(),
    });

    const results: Record<string, unknown> = {};
    for (const letter of ["a", "b"]) {
      const clientId = `${prefix}-${letter}`;
      const now = new Date();
      // oxlint-disable-next-line no-await-in-loop -- one client after the other
      await db.insert(clients).values({
        id: clientId,
        name: clientId,
        accountId: `qual-${letter}-${crypto.randomUUID()}`,
        createdAt: now,
        updatedAt: now,
      });
      // Placed first, so its deployment id (and every physical name) carries the prefix.
      // oxlint-disable-next-line no-await-in-loop -- as above
      await placeClient(db, staff, {
        clientId,
        destinationId,
        policyId: "eu-storage",
      });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await db
        .update(clientPlacements)
        .set({ deploymentId: `${prefix}-${letter}` })
        .where(eq(clientPlacements.clientId, clientId));
      // Staff's retry resumes a failed operation: tried again, as they would,
      // only for a failure the admin's words call a retry's to fix.
      const attempts: unknown[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        let started: unknown;
        try {
          // oxlint-disable-next-line no-await-in-loop -- one attempt after another
          started = await placeAndProvision(env, staff, {
            clientId,
            releaseId,
            policyId: "eu-storage",
            destinationId,
          });
          // oxlint-disable-next-line no-await-in-loop -- as above
          await waitForRun(clientId);
        } catch (error) {
          started = { error: String(error) };
        }
        // oxlint-disable-next-line no-await-in-loop -- as above
        const state = await db
          .select()
          .from(clientProvisions)
          .where(eq(clientProvisions.clientId, clientId))
          .get();
        attempts.push({
          started,
          status: state?.status,
          step: state?.step,
          error: state?.error,
        });
        // oxlint-disable-next-line no-await-in-loop -- as above
        await report("attempt", {
          clientId,
          attempt,
          started,
          status: state?.status,
          step: state?.step,
          error: state?.error,
        });
        if (state?.status !== "failed" || state.error !== "upload_unobserved") {
          break;
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- as above
      const operation = await db
        .select()
        .from(clientProvisions)
        .where(eq(clientProvisions.clientId, clientId))
        .get();
      // oxlint-disable-next-line no-await-in-loop -- as above
      const resources = await db
        .select()
        .from(clientResources)
        .where(eq(clientResources.clientId, clientId));
      results[clientId] = {
        attempts,
        operation:
          operation === undefined
            ? null
            : {
                status: operation.status,
                step: operation.step,
                error: operation.error,
                progress: operation.progress,
              },
        resources: resources.map((resource) => ({
          role: resource.role,
          kind: resource.kind,
          name: resource.physicalName,
          id: resource.providerId,
          lifecycle: resource.lifecycle,
        })),
      };
    }
    await report("clients", results);
  }
);
