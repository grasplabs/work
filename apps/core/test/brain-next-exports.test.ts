import { brainExportErrors } from "@grasp-os/shared/brain-exports";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  brainExportsPath,
  brainOwnExportPath,
  brainRestorePath,
} from "../src/brain-next-exports.ts";
import {
  addSource,
  erasePerson,
  readSourceVersionAs,
  workBrain,
} from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
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

/** The R2 calls the Brain's store makes, passed through. */
const r2Calls = ["get", "head", "put", "delete", "list"] as const;

/**
 * The shared Brain store's bucket failing every read and write of a
 * source's file (`sources/`), as R2 out of reach for them: what a skill's
 * write meets. Every other call goes through. Answers how to heal it.
 */
const failingSourceFiles = async (): Promise<() => Promise<void>> => {
  const store = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
  const bucket = env.BRAIN_OBJECTS;
  const swap = async (to: unknown): Promise<void> => {
    await runInDurableObject(store, (instance) => {
      const objectEnv: unknown = Reflect.get(instance, "env");
      if (typeof objectEnv !== "object" || objectEnv === null) {
        throw new TypeError("The store has no env");
      }
      Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: to });
    });
  };
  await swap(
    Object.fromEntries(
      r2Calls.map((name) => [
        name,
        async (...args: unknown[]): Promise<unknown> => {
          const [key] = args;
          if (typeof key === "string" && key.startsWith("sources/")) {
            await Promise.resolve();
            throw new Error("R2 out of reach");
          }
          const method: unknown = Reflect.get(bucket, name);
          if (typeof method !== "function") {
            throw new TypeError(`R2 has no ${name}`);
          }
          const result: unknown = await Reflect.apply(method, bucket, args);
          return result;
        },
      ])
    )
  );
  return async () => {
    await swap(bucket);
  };
};

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

/** The query of the company's export `id`, as an admin asks it. */
const queryOfCompany = (id: string): string =>
  `${brainExportsPath}?${new URLSearchParams({ id }).toString()}`;

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

    // Run before anything is added to the shared store: a restore goes
    // only into one that holds nothing but Grasp's own skills.
    it("starts no restore when Grasp's own skills could not be installed first, on record as failed, and starts it once they can be (threat 9)", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const id = await start(admin.session);
      await writtenFiles(admin.session, id);
      // The store's bucket fails every source file: no skill can be read
      // or written.
      const heal = await failingSourceFiles();
      let refused: Response | undefined;
      let events: Awaited<ReturnType<typeof auditedDuring>> = [];
      try {
        events = await auditedDuring(async () => {
          refused = await request(admin.session, brainRestorePath, {
            method: "POST",
            body: { exportId: id },
          });
        });
      } finally {
        await heal();
      }
      const { code } = z
        .object({ code: z.string() })
        .parse(await refused?.json());
      const notStarted = await request(
        admin.session,
        `${brainRestorePath}?id=${id}`
      );
      // Once the skills can be installed, the same restore starts.
      const again = await request(admin.session, brainRestorePath, {
        method: "POST",
        body: { exportId: id },
      });
      const { state } = z
        .object({ state: z.string() })
        .parse(await again.json());
      // Done, so the store takes adds and exports again for what follows.
      await workBrain(env, new Date(), noProducers);
      await workBrain(env, new Date(), noProducers);
      expect({
        status: refused?.status,
        code,
        audited: events
          .filter(({ action }) => action.startsWith("brain.restore."))
          .map(({ action, detail }) => [action, detail?.outcome ?? null]),
        notStarted: notStarted.status,
        again: again.status,
        state,
      }).toStrictEqual({
        status: 503,
        code: "brain.restore_unprepared",
        audited: [
          ["brain.restore.asked", null],
          ["brain.restore.answered", "failed"],
        ],
        notStarted: 404,
        again: 200,
        state: "running",
      });
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
      let id = "";
      const events = await auditedDuring(async () => {
        id = await start(admin.session);
        bodies = await writtenFiles(admin.session, id);
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
        answeredWith: exportEvents.find(
          ({ action }) => action === "brain.export.answered"
        )?.detail,
        named: JSON.stringify(exportEvents).includes(shared),
      }).toStrictEqual({
        shared: true,
        theirs: false,
        actions: [
          "brain.export.asked",
          "brain.export.answered",
          ...bodies.map(() => "brain.export.downloaded"),
        ],
        answeredWith: { outcome: "started", exportId: id },
        named: false,
      });
    });

    it("answers an export started, and a shared add made, while a restore runs with a code of their own, and keeps a person's own add in their own store meanwhile", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const store = inJurisdiction(env, env.BRAIN_STORE).getByName("brain");
      const restoring = crypto.randomUUID();
      // A restore under way, as the store records one.
      await runInDurableObject(store, (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO restores (export, checked, part, restored, state, started_at)
          VALUES (?, 0, 0, 0, 'running', ?)`,
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
        // What only one person may read goes to their own store, which no
        // restore touches: kept, never lost.
        const mine = { producer: "upload", id: crypto.randomUUID() } as const;
        const text = `mine while it restores ${crypto.randomUUID()}`;
        const { version } = await addSource(env, {
          source: mine,
          change: "1",
          text,
          readers: { kind: "owner", personId: admin.userId },
        });
        const read = await readSourceVersionAs(env, admin.userId, {
          source: mine,
          version,
        });
        expect({
          status: started.status,
          code,
          added,
          own: read?.text,
        }).toStrictEqual({
          status: 409,
          code: "brain.export_refused",
          added: "brain.restoring",
          own: text,
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

const ownStatusSchema = z.object({
  export: z
    .object({ id: z.uuid(), state: z.string(), files: z.array(z.string()) })
    .nullable(),
});

/** What `cookie`'s person's own export shows them now. */
const ownStatusOf = async (cookie: string) => {
  const response = await request(cookie, brainOwnExportPath);
  const { export: shown } = ownStatusSchema.parse(await response.json());
  return shown;
};

/** The query of a file of a person's own export. */
const ownFileOf = (id: string, file: string): string =>
  `${brainOwnExportPath}?${new URLSearchParams({ id, file }).toString()}`;

/**
 * Starts `cookie`'s person's own export, and lets their store's own alarm
 * (core's subclass, its host core's) write it: at most 10 alarms. Its id.
 */
const ownExported = async (cookie: string, personId: string) => {
  const started = await request(cookie, brainOwnExportPath, {
    method: "POST",
  });
  const { id } = startedSchema.parse(await started.json());
  const store = inJurisdiction(env, env.BRAIN_STORE).getByName(
    `person:${personId}`
  );
  for (let alarms = 0; alarms < 10; alarms += 1) {
    // oxlint-disable-next-line no-await-in-loop -- an alarm at a time
    const shown = await ownStatusOf(cookie);
    if (shown?.state !== "writing") {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- an alarm at a time
    await runDurableObjectAlarm(store);
  }
  return id;
};

/** The SHA-256 of `text`, in hex: how a person's own part of the bucket is named. */
const sha256 = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The keys of `personId`'s own exports' files, as the bucket lists them. */
const ownExportKeys = async (personId: string): Promise<string[]> => {
  const listed = await env.BRAIN_OBJECTS.list({
    prefix: `people/${await sha256(personId)}/exports/`,
  });
  return listed.objects.map(({ key }) => key);
};

describe(
  "a person's own export over core's route",
  { timeout: 120_000 },
  () => {
    // GRA-1839 threats 1, 2, 9: theirs alone to start, follow and
    // download, on record on them, by ids only.
    it("lets a person export and download what only they may read, and nobody else, an admin and staff among them, reach it", async () => {
      const member = await signedInWithRole(idp, "user");
      const admin = await signedInWithRole(idp, "admin");
      const staff = await signedIn(idp, "grasp-staff", staffPerson());
      const marker = `own${crypto.randomUUID().replaceAll("-", "")}`;
      const company = `company${crypto.randomUUID().replaceAll("-", "")}`;
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: "1",
        text: `My own ${marker}`,
        readers: { kind: "owner", personId: member.userId },
      });
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: "1",
        text: `The company's ${company}`,
        readers: { kind: "team", teamId: crypto.randomUUID() },
      });

      let id = "";
      let bodies: string[] = [];
      const events = await auditedDuring(async () => {
        id = await ownExported(member.session, member.userId);
        const status = await ownStatusOf(member.session);
        bodies = [];
        for (const file of status?.files ?? []) {
          // oxlint-disable-next-line no-await-in-loop -- one file at a time
          const downloaded = await request(member.session, ownFileOf(id, file));
          expect(downloaded.headers.get("content-disposition")).toMatch(
            /^attachment;/u
          );
          // oxlint-disable-next-line no-await-in-loop -- one file at a time
          bodies.push(await downloaded.text());
        }
      });
      const all = bodies.join("\n");
      const exportEvents = events.filter(({ action }) =>
        action.startsWith("brain.export.")
      );

      // Anyone else: their own (none), or not found, alike.
      const others = await Promise.all([
        request(admin.session, ownFileOf(id, "manifest.json")),
        request(admin.session, ownFileOf(crypto.randomUUID(), "manifest.json")),
        request(admin.session, queryOfCompany(id)),
        request(staff, brainOwnExportPath),
        request(staff, ownFileOf(id, "manifest.json")),
        request("", ownFileOf(id, "manifest.json")),
        request(member.session, ownFileOf(id, "manifest.json"), {
          site: "cross-site",
        }),
        request(member.session, brainOwnExportPath, {
          method: "POST",
          site: "cross-site",
        }),
      ]);

      expect({
        marker: all.includes(marker),
        company: all.includes(company),
        adminSees: await ownStatusOf(admin.session),
        others: others.map(({ status }) => status),
        actions: exportEvents.map(({ action }) => action),
        on: [...new Set(exportEvents.map(({ target }) => target?.id))],
        answeredWith: exportEvents.find(
          ({ action }) => action === "brain.export.answered"
        )?.detail,
        named: JSON.stringify(exportEvents).includes(marker),
      }).toStrictEqual({
        marker: true,
        company: false,
        adminSees: null,
        others: [404, 404, 404, 401, 401, 401, 403, 403],
        actions: [
          "brain.export.asked",
          "brain.export.answered",
          ...bodies.map(() => "brain.export.downloaded"),
        ],
        on: [member.userId],
        answeredWith: { scope: "own", outcome: "started", exportId: id },
        named: false,
      });
    });

    // GRA-1839 threat 6 and the acceptance criterion: by listing the bucket.
    it("leaves no file of a person's own export in the bucket once they are erased", async () => {
      const member = await signedInWithRole(idp, "user");
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: "1",
        text: "Mine alone",
        readers: { kind: "owner", personId: member.userId },
      });
      await ownExported(member.session, member.userId);
      const before = await ownExportKeys(member.userId);
      const erase = async () =>
        await erasePerson(env, {
          personId: member.userId,
          reason: "person_erased",
        });
      const first = await erase();
      await ageOwnErasure(member.userId);
      const done = await erase();
      expect({
        before: before.length > 0,
        answered: [first, done],
        after: await ownExportKeys(member.userId),
      }).toStrictEqual({
        before: true,
        answered: ["still_deleting", "erased"],
        after: [],
      });
    });
  }
);
