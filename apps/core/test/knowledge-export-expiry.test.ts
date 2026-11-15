import {
  advanceExport,
  exportLifetimeMs,
  exportUploadWindowMs,
  prepareExport,
  startExport,
} from "@grasp-os/brain/exports";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainOf } from "../src/knowledge/ports.ts";
import { mockIdp } from "./idp.ts";
import { purged } from "./knowledge-purge.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Today's Brain's exports, as the export of the company's Brain left them
// before nothing could export any more: files under `exports/<id>/` in the
// Brain's bucket, holding every version of the company's documents. The
// clock deletes them as it always did (src/knowledge/export-expiry.ts):
// a complete one once its download window is over, one a purge ran after
// at once, and one left running stopped; a delete R2 refuses is tried
// again, never taken as done.

const idp = mockIdp();

const setUpTime = { timeout: 120_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** An export of the company's Brain asked for by `admin`, as the old flow wrote it. */
const exportedBy = async (
  admin: Person,
  { complete }: { complete: boolean }
): Promise<string> => {
  const brain = brainOf(env);
  const by = {
    actor: { type: "person" as const, userId: admin.userId },
    userId: admin.userId,
  };
  const onExport = { excluded: [], files: [] };
  const { token } = await prepareExport(brain, by, onExport);
  const { exportId } = await startExport(brain, by, token, onExport);
  if (complete) {
    for (let tick = 0; tick < 20; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      const done = await advanceExport(
        brain,
        exportId,
        onExport,
        new Date(Date.now() + 60_000)
      );
      if (done) {
        return exportId;
      }
    }
    throw new Error(`Export ${exportId} is still running`);
  }
  // A file a run uploaded before exports stopped.
  await env.BRAIN_OBJECTS.put(
    `exports/${exportId}/collections-0001.jsonl`,
    "{}\n"
  );
  return exportId;
};

/** Every object the bucket keeps for export `exportId`. */
const objectsOf = async (exportId: string): Promise<string[]> => {
  const listed = await env.BRAIN_OBJECTS.list({
    prefix: `exports/${exportId}/`,
  });
  return listed.objects.map(({ key }) => key);
};

/** Whether any of export `exportId`'s files holds `text`. */
const holds = async (exportId: string, text: string): Promise<boolean> => {
  const keys = await objectsOf(exportId);
  const bodies = await Promise.all(
    keys.map(async (key) => {
      const object = await env.BRAIN_OBJECTS.get(key);
      return await object?.text();
    })
  );
  return bodies.some((body) => body?.includes(text) === true);
};

/** A document of the company's in a collection for everyone, holding `text`. */
const companyDocument = async (admin: Person, text: string) => {
  const handbook = await admin.api.knowledge.createCollection({
    name: `Handbook ${unique()}`,
    access: "everyone",
  });
  return await admin.api.knowledge.saveDocument({
    collectionId: handbook.id,
    path: "people.md",
    text,
    ifVersion: 0,
  });
};

/** R2 refusing every delete, as when it is out of reach. */
const refusingDeletes = (): R2Bucket =>
  new Proxy(env.BRAIN_OBJECTS, {
    get: (target, property) => {
      if (property === "delete") {
        return async () => {
          await Promise.resolve();
          throw new Error("R2 is out of reach");
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });

describe("today's Brain's exports", setUpTime, () => {
  it("are deleted once their download window is over", async () => {
    const admin = await signedInApi(idp, "admin");
    const marker = `window${unique().replaceAll("-", "")}`;
    await companyDocument(admin, `# People\nWrite to ${marker}.`);
    const exportId = await exportedBy(admin, { complete: true });
    const written = await holds(exportId, marker);
    // Within its window: kept.
    await runMinuteTasks({}, new Date(Date.now() + exportLifetimeMs / 2));
    const kept = await objectsOf(exportId);
    const within = kept.length > 0;
    await runMinuteTasks(
      {},
      new Date(Date.now() + exportLifetimeMs + exportUploadWindowMs + 60_000)
    );

    expect({ written, within, left: await objectsOf(exportId) }).toStrictEqual({
      written: true,
      within: true,
      left: [],
    });
  });

  it("are deleted at once once a person's erasure ran after them, and tried again while R2 refuses", async () => {
    const admin = await signedInApi(idp, "admin");
    const leaver = await signedInApi(idp, "user");
    const marker = `erased${unique().replaceAll("-", "")}`;
    await companyDocument(admin, `# People\nWrite to ${marker}.`);
    const exportId = await exportedBy(admin, { complete: true });
    const written = await holds(exportId, marker);
    await purged(admin, leaver.userId);
    await runMinuteTasks({ BRAIN_OBJECTS: refusingDeletes() });
    const whileRefused = await holds(exportId, marker);
    await runMinuteTasks();

    expect({
      written,
      whileRefused,
      left: await objectsOf(exportId),
    }).toStrictEqual({ written: true, whileRefused: true, left: [] });
  });

  it("left running are stopped, and what they wrote deleted", async () => {
    const admin = await signedInApi(idp, "admin");
    const exportId = await exportedBy(admin, { complete: false });
    const before = await objectsOf(exportId);
    await runMinuteTasks();
    const state = await env.KNOWLEDGE.prepare(
      "SELECT state, reason FROM brain_exports WHERE id = ?"
    )
      .bind(exportId)
      .first<{ state: string; reason: string | null }>();

    expect({
      before: before.length,
      state,
      left: await objectsOf(exportId),
    }).toStrictEqual({
      before: 1,
      state: { state: "failed", reason: "knowledge.export_stopped" },
      left: [],
    });
  });
});
