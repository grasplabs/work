import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  brainExportsPath,
  brainRestorePath,
} from "../src/brain-next-exports.ts";
import { addSource, workBrain } from "../src/brain-next.ts";
import { mockIdp } from "./idp.ts";
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

const startedSchema = z.object({
  exports: z.array(z.object({ store: z.literal("shared"), id: z.uuid() })),
  holds: z.string().optional(),
});

const statusSchema = z.object({
  state: z.string(),
  files: z.array(z.string()),
});

/** Starts an export of `scope` on `cookie`: its exports by store, and what it says it holds. */
const start = async (
  cookie: string,
  scope: "company" | "own"
): Promise<{ exports: Record<string, string>; holds?: string }> => {
  const response = await request(cookie, brainExportsPath, {
    method: "POST",
    body: { scope },
  });
  const { exports, holds } = startedSchema.parse(await response.json());
  return {
    exports: Object.fromEntries(exports.map(({ store, id }) => [store, id])),
    ...(holds === undefined ? {} : { holds }),
  };
};

/** The query of an export of `scope` in `store`. */
const queryOf = (
  scope: "company" | "own",
  store: string,
  id: string,
  file?: string
): string =>
  `${brainExportsPath}?${new URLSearchParams({
    scope,
    store,
    id,
    ...(file === undefined ? {} : { file }),
  }).toString()}`;

/**
 * Ticks the shared store until each export in `exports` is written, then
 * reads every file of each on `cookie`.
 */
const writtenFiles = async (
  cookie: string,
  scope: "company" | "own",
  exports: Record<string, string>
): Promise<string[]> => {
  await workBrain(env, new Date());
  const bodies: string[] = [];
  for (const [store, id] of Object.entries(exports)) {
    // oxlint-disable-next-line no-await-in-loop -- one export at a time
    const response = await request(cookie, queryOf(scope, store, id));
    // oxlint-disable-next-line no-await-in-loop -- one export at a time
    const status = statusSchema.parse(await response.json());
    expect(status.state).toBe("done");
    for (const file of status.files) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time
      const downloaded = await request(cookie, queryOf(scope, store, id, file));
      expect(downloaded.headers.get("content-disposition")).toMatch(
        /^attachment;/u
      );
      // oxlint-disable-next-line no-await-in-loop -- one file at a time
      bodies.push(await downloaded.text());
    }
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
      const startCompany = { method: "POST", body: { scope: "company" } };
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

    it("gives a person their own export, with only what they alone may read and a plain word of what it holds, which no admin can read (threats 2, 5, 12)", async () => {
      const admin = await signedInWithRole(idp, "admin");
      const member = await signedInWithRole(idp, "user");
      const theirs = `theirs${crypto.randomUUID().replaceAll("-", "")}`;
      const others = `others${crypto.randomUUID().replaceAll("-", "")}`;
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: "1",
        text: `Notes of ${theirs}`,
        readers: { kind: "owner", personId: member.userId },
      });
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: "1",
        text: `Notes of ${others}`,
        readers: { kind: "owner", personId: admin.userId },
      });

      let exports: Record<string, string> = {};
      let bodies: string[] = [];
      let holds: string | undefined;
      const events = await auditedDuring(async () => {
        ({ exports, holds } = await start(member.session, "own"));
        bodies = await writtenFiles(member.session, "own", exports);
      });

      const all = bodies.join("\n");
      expect({
        stores: Object.keys(exports),
        // Said plainly: their own space's content is not in it yet.
        saysOwnLeftOut: holds?.includes("not in this export yet"),
        theirs: all.includes(theirs),
        others: all.includes(others),
      }).toStrictEqual({
        stores: ["shared"],
        saysOwnLeftOut: true,
        theirs: true,
        others: false,
      });
      // On record, naming no content.
      const exportEvents = events.filter(({ action }) =>
        action.startsWith("brain.export.")
      );
      expect(exportEvents.map(({ action }) => action)).toStrictEqual([
        "brain.export.asked",
        "brain.export.answered",
        ...bodies.map(() => "brain.export.downloaded"),
      ]);
      expect(JSON.stringify(exportEvents)).not.toContain(theirs);

      // The admin finds none of it, as the company or as themselves.
      const asAdmin = await Promise.all(
        [
          queryOf("company", "shared", exports.shared ?? ""),
          queryOf("own", "shared", exports.shared ?? ""),
          queryOf("company", "shared", exports.shared ?? "", "manifest.json"),
          queryOf("own", "shared", exports.shared ?? "", "manifest.json"),
        ].map(async (path) => {
          const { status } = await request(admin.session, path);
          return status;
        })
      );
      expect(asAdmin).toStrictEqual([404, 404, 404, 404]);
    });

    it("gives an admin the company's export, without anything one person alone may read (threat 4)", async () => {
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

      const { exports } = await start(admin.session, "company");
      const bodies = await writtenFiles(admin.session, "company", exports);
      const all = bodies.join("\n");

      expect(Object.keys(exports)).toStrictEqual(["shared"]);
      expect({
        shared: all.includes(shared),
        theirs: all.includes(theirs),
      }).toStrictEqual({ shared: true, theirs: false });
    });
  }
);
