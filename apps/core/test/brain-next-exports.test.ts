import { brainExportErrors } from "@grasp-os/shared/brain-exports";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  brainExportsPath,
  brainRestorePath,
} from "../src/brain-next-exports.ts";
import { addSource, workBrain } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { mockIdp } from "./idp.ts";
import { noProducers } from "./no-producers.ts";
import {
  auditedDuring,
  routed,
  signedIn,
  signedInWithRole,
  staffPerson,
} from "./sign-in.ts";

// Exports of the new Brain over core's routes (src/brain-next-exports.ts,
// GRA-1755): who may start and read which, and what each holds. The
// Brain's own tests (packages/brain-next/test/exports.test.ts) hold the
// rest: history, erasure, restore. The threat model is on GRA-1755.

const idp = mockIdp();

/** A request of core's own page, signed in on `cookie`. */
const request = async (
  cookie: string,
  path: string,
  init: { method?: string; body?: unknown; site?: string } = {}
): Promise<Response> =>
  await routed(path, {
    method: init.method ?? "GET",
    headers: {
      cookie,
      "sec-fetch-site": init.site ?? "same-origin",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

const startedSchema = z.object({ id: z.uuid() });

const statusSchema = z.object({
  state: z.string(),
  files: z.array(z.string()),
});

/** Starts an export of the company's Brain on `cookie`: its id. */
const start = async (cookie: string): Promise<string> => {
  const response = await request(cookie, brainExportsPath, { method: "POST" });
  const { id } = startedSchema.parse(await response.json());
  return id;
};

/** The query of export `id`, or of one of its files. */
const queryOf = (id: string, file?: string): string =>
  `${brainExportsPath}?${new URLSearchParams({
    id,
    ...(file === undefined ? {} : { file }),
  }).toString()}`;

/**
 * Ticks the shared store until export `id` is written, then reads every
 * file of it on `cookie`.
 */
const writtenFiles = async (cookie: string, id: string): Promise<string[]> => {
  await workBrain(env, new Date(), noProducers);
  const response = await request(cookie, queryOf(id));
  const status = statusSchema.parse(await response.json());
  expect(status.state).toBe("done");
  const bodies: string[] = [];
  for (const file of status.files) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    const downloaded = await request(cookie, queryOf(id, file));
    expect(downloaded.headers.get("content-disposition")).toMatch(
      /^attachment;/u
    );
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    bodies.push(await downloaded.text());
  }
  return bodies;
};

describe(
  "exports of the Brain over core's routes",
  { timeout: 120_000 },
  () => {
    // Staff reach no client's workspace by signing in (they act only as an
    // added user): unauthenticated here, as anyone not signed in.
    it("lets only an admin, never staff or a member, start the company's export or a restore, and only from core's own site (threat 1)", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const member = await signedInWithRole(idp, "user");
      const staff = await signedIn(idp, "grasp-staff", staffPerson());
      const startCompany = { method: "POST" };
      const restore = {
        method: "POST",
        body: { exportId: crypto.randomUUID() },
      };

      const statuses = await Promise.all([
        request(member.session, brainExportsPath, startCompany),
        request(staff, brainExportsPath, startCompany),
        request("", brainExportsPath, startCompany),
        request(admin.session, brainExportsPath, {
          ...startCompany,
          site: "cross-site",
        }),
        request(member.session, brainRestorePath, restore),
        request(staff, brainRestorePath, restore),
        request(
          member.session,
          `${brainRestorePath}?id=${crypto.randomUUID()}`
        ),
        // The admin's restore of an export no one made: refused, as a
        // conflict with what the Brain holds, not an error of core's.
        request(admin.session, brainRestorePath, restore),
      ]);

      expect(statuses.map(({ status }) => status)).toStrictEqual([
        403, 401, 401, 403, 403, 401, 403, 409,
      ]);
    });

    it("gives an admin the company's export, without anything one person alone may read, on record without its content (threats 4, 12)", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const member = await signedInWithRole(idp, "user");
      const shared = `shared${crypto.randomUUID().replaceAll("-", "")}`;
      const theirs = `theirs${crypto.randomUUID().replaceAll("-", "")}`;
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: "1",
        text: `The company's ${shared}`,
        readers: { kind: "team", teamId: crypto.randomUUID() },
      });
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: "1",
        text: `An interview of ${theirs}`,
        readers: { kind: "owner", personId: member.userId },
      });

      let bodies: string[] = [];
      const events = await auditedDuring(async () => {
        bodies = await writtenFiles(admin.session, await start(admin.session));
      });
      const all = bodies.join("\n");
      const exportEvents = events.filter(({ action }) =>
        action.startsWith("brain.export.")
      );

      expect({
        shared: all.includes(shared),
        theirs: all.includes(theirs),
        // On record, naming no content.
        actions: exportEvents.map(({ action }) => action),
        named: JSON.stringify(exportEvents).includes(shared),
      }).toStrictEqual({
        shared: true,
        theirs: false,
        actions: [
          "brain.export.asked",
          "brain.export.answered",
          ...bodies.map(() => "brain.export.downloaded"),
        ],
        named: false,
      });
    });

    it("answers an export started, and an add made, while a restore runs with a code of their own: a conflict, never an error of core's", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const store = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
      const restoring = crypto.randomUUID();
      // A restore under way, as the store records one.
      await runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO restores (export, manifest, checked, part, restored, state, started_at)
          VALUES (?, '{}', 0, 0, 0, 'running', ?)`,
          restoring,
          Date.now()
        );
      });
      try {
        const started = await request(admin.session, brainExportsPath, {
          method: "POST",
        });
        const { code } = z
          .object({ code: z.string() })
          .parse(await started.json());
        let added: string | undefined;
        try {
          await addSource(env, {
            source: { producer: "upload", id: crypto.randomUUID() },
            change: "1",
            text: "words while it restores",
            readers: { kind: "team", teamId: crypto.randomUUID() },
          });
        } catch (error) {
          added = brainExportErrors.codeOf(error);
        }
        expect({
          status: started.status,
          code,
          added,
        }).toStrictEqual({
          status: 409,
          code: "brain.export_refused",
          added: "brain.restoring",
        });
      } finally {
        await runInDurableObject(store, (_instance, state) => {
          state.storage.sql.exec(
            "DELETE FROM restores WHERE export = ?",
            restoring
          );
        });
      }
    });
  }
);
