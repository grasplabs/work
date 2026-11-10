import type { FunctionReference, ReferenceKind } from "@grasp-os/runtime/app";
import { GraspClient } from "@grasp-os/runtime/host";
import type { ClientTransport } from "@grasp-os/runtime/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import {
  appFunctionPath,
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { commitApp, withFiles } from "./app-definitions.ts";
import type { TestSource } from "./app-definitions.ts";
import { pastAccessRecheck, published } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { apiOf, notesFiles } from "./notes-client-app.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { auditedDuring, outcome, routed, signedInApi } from "./sign-in.ts";

// A tab's App frames on the one connection they share (spec 11.2), each
// through its own way to its App (`pages.frame`), as the page's page
// host runs them. Threat model, each tried below through core's real
// connection:
//
// - Frame A decided on frame B's build: two frames of one App on one
//   connection, each on its own version's build; the older version's
//   release revoked stops that frame only, and a frame with no lease of
//   core's never borrows another frame's.
// - One frame's revocation reaching another's pushes: each frame follows
//   the App's notes (`watchQuery`); after one frame's release is revoked,
//   only the other frame is pushed the App's changes.
// - A closed frame following on: two frames follow the same live query
//   (one read shared between them); closing one lets go of its callback
//   at once, and the other is still pushed every change.
//
// The frames' calls of the App's functions carry each frame's own lease
// (app-function-route.ts), so they can't borrow another frame's build on
// the connection: what is shared, and tried here, is what a frame asks
// through it.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/** A new App with `files` as its current version: nobody approves its pages. */
const currentApp = async (builder: Person, files: TestSource) => {
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await published(id);
  const { version } = await commitApp(
    builder.api.apps.files,
    id,
    files,
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  return { app: id, version };
};

/**
 * Two pages, so two builds; and the App's `api`, as they call it.
 */
const twoPageApp = async (builder: Person) => {
  const notesPage = notesFiles.files["src/routes/index.tsx"] ?? "";
  const { app, version } = await currentApp(
    builder,
    withFiles(notesFiles, {
      "src/routes/other.tsx": notesPage.replace(">Add<", ">Other<"),
    })
  );
  return { app, version, api: apiOf(await loadRelease(env, app, version)) };
};

/**
 * The Notes App's next version, its page changed, made current; and the
 * App's `api` at it.
 */
const nextVersion = async (builder: Person, app: string) => {
  const notesPage = notesFiles.files["src/routes/index.tsx"] ?? "";
  const { version } = await commitApp(
    builder.api.apps.files,
    app,
    { "src/routes/index.tsx": notesPage.replace(">Add<", ">Add a note<") },
    "Second"
  );
  await builder.api.apps.versions.setCurrent(app, version);
  return {
    version,
    api: apiOf(await loadRelease(env, appIdSchema.parse(app), version)),
  };
};

/** Revokes the release of `version` of `app`, as an admin. */
const revoked = async (app: string, version: number): Promise<void> => {
  await revokeRelease(
    env,
    await actingPerson("admin"),
    { app: appIdSchema.parse(app), version },
    "Leaks data"
  );
};

/** The refusals among `events` for `app`, as what was refused where. */
const refusalsOf = (
  events: Awaited<ReturnType<typeof auditedDuring>>,
  app: string
): string[] =>
  events
    .filter(
      ({ action, target }) =>
        action === "app.artifact.refused" && target?.id === app
    )
    .map(
      ({ detail }) => `${detail.operation}/${detail.stage}: ${detail.reason}`
    )
    .toSorted();

/**
 * A live query's refusal of a build whose release was revoked, recorded
 * by whichever check meets it first: its read (`admission`) or the push
 * of what it read (`push`).
 */
const liveRefusal = /^watchQuery\/(?:admission|push): revoked$/u;

const pushSchema = z.object({
  revision: z.number(),
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});

/** A page's callback for a frame's live query, and whether core let go of it. */
const follower = () => {
  const titles: string[][] = [];
  const refused: string[] = [];
  const state = { released: false };
  const callback = Object.assign(
    (push: unknown): void => {
      const { result } = pushSchema.parse(push);
      if (result.ok) {
        titles.push(
          z
            .object({ items: z.array(z.object({ title: z.string() })) })
            .parse(result.value)
            .items.map(({ title }) => title)
        );
      } else {
        refused.push(result.error.code);
      }
    },
    {
      [Symbol.dispose]: (): void => {
        state.released = true;
      },
    }
  );
  return { titles, refused, state, callback };
};

/** A query's call as the client sends it. */
const requestOf = (
  reference: FunctionReference<ReferenceKind>,
  input: unknown,
  kind: ReferenceKind = "query"
): string =>
  JSON.stringify({
    reference: { name: reference.name, kind },
    args: input,
  });

/** A session client whose calls go to core's function route, as the page relays them. */
const callingClient = (
  { app, lease }: { app: string; lease: string },
  person: Person
): GraspClient => {
  const transport: ClientTransport = {
    watch: async () => {
      await Promise.resolve();
      throw new Error("This client only calls.");
    },
    call: async (request) => {
      const response = await routed(`${appFunctionPath}/${app}`, {
        method: "POST",
        headers: {
          origin: clientOrigin,
          "content-type": "application/json",
          cookie: person.session,
          [pageLeaseHeader]: lease,
          [pagePersonHeader]: person.userId,
        },
        body: request,
      });
      const answer: unknown = await response.json();
      if (response.ok) {
        return answer;
      }
      const payload = errorPayloadSchema.parse(answer);
      throw Object.assign(new Error(payload.message), { code: payload.code });
    },
  };
  return new GraspClient(transport);
};

/** How long a push may take to arrive, and how often to look. */
const pushWait = { timeout: 20_000, interval: 50 };

describe("frames sharing a tab's connection", { timeout: 120_000 }, () => {
  it("decides each frame on its own build, whatever another frame of the App on the connection runs", async () => {
    const builder = await personApi("builder");
    const { app, version, api } = await twoPageApp(builder);
    const request = requestOf(api.list, { pagination: { pageSize: 10 } });
    const { pages } = builder.api;
    const notes = await pages.open(app);
    const notesFrame = await pages.frame(app, notes.lease);
    const beforeFollower = follower();
    const before = await outcome(
      notesFrame.watchQuery(request, beforeFollower.callback)
    );
    await vi.waitFor(() => {
      expect(beforeFollower.titles).toStrictEqual([[]]);
    }, pushWait);
    // The next version current, and a frame of it: made last, the one a
    // connection-wide build would have followed.
    const second = await nextVersion(builder, app);
    const otherRequest = requestOf(second.api.list, {
      pagination: { pageSize: 10 },
    });
    const other = await pages.open(app);
    const otherFrame = await pages.frame(app, other.lease);
    const unleased = await pages.frame(app, `${notes.artifact}.forged`);

    await revoked(app, version);
    // The revocation ends the live query it already had, once the App's
    // open pages are told to look again (GRA-668), which happens after
    // the revocation answers: refused, and recorded as a push refusal, at
    // a moment of its own. Waited for here, so what follows records only
    // what each frame then asks, whatever the timing.
    await vi.waitFor(() => {
      expect(beforeFollower.refused).toStrictEqual(["page.revoked"]);
    }, pushWait);

    let after: Record<string, unknown> = {};
    const events = await auditedDuring(async () => {
      after = {
        notes: await outcome(
          notesFrame.watchQuery(request, follower().callback)
        ),
        notesDecision: await outcome(
          notesFrame.reviewDecision("run-1", "review", { approved: true })
        ),
        notesDelivery: await notesFrame.delivery(),
        other: await outcome(
          otherFrame.watchQuery(otherRequest, follower().callback)
        ),
        otherDelivery: await otherFrame.delivery(),
        unleased: await outcome(
          unleased.watchQuery(otherRequest, follower().callback)
        ),
        unleasedDecision: await outcome(
          unleased.reviewDecision("run-1", "review", { approved: true })
        ),
      };
    });

    expect({
      before,
      // Nothing reached it after its release was revoked.
      beforePushed: beforeFollower.titles,
      after,
      refused: refusalsOf(events, app),
    }).toStrictEqual({
      before: "ok",
      beforePushed: [[]],
      after: {
        notes: "page.revoked",
        notesDecision: "page.revoked",
        notesDelivery: "revoked",
        other: "ok",
        otherDelivery: "open",
        unleased: "page.unreviewed",
        unleasedDecision: "page.unreviewed",
      },
      // Each refused by the gate, as its own frame's build.
      refused: [
        "reviewDecision/admission: revoked",
        "reviewDecision/admission: unreviewed",
        "watchQuery/admission: revoked",
        "watchQuery/admission: unreviewed",
      ],
    });
  });

  it("stops the pushes of a frame whose release was revoked, and only that frame's", async () => {
    const builder = await personApi("builder");
    const { app, version, api } = await twoPageApp(builder);
    const request = requestOf(api.list, { pagination: { pageSize: 10 } });
    const { pages } = builder.api;
    const notes = await pages.open(app);
    const notesFrame = await pages.frame(app, notes.lease);
    const second = await nextVersion(builder, app);
    const otherRequest = requestOf(second.api.list, {
      pagination: { pageSize: 10 },
    });
    const other = await pages.open(app);
    const otherFrame = await pages.frame(app, other.lease);
    const toNotes = follower();
    const toOther = follower();
    await notesFrame.watchQuery(request, toNotes.callback);
    await otherFrame.watchQuery(otherRequest, toOther.callback);
    // Both first reads in before anything changes, so what each is pushed
    // is known exactly.
    await vi.waitFor(() => {
      expect([toNotes.titles, toOther.titles]).toStrictEqual([[[]], [[]]]);
    }, pushWait);
    const client = callingClient({ app, lease: other.lease }, builder);
    await client.mutation(second.api.create, { title: "Before" });
    // Both frames are pushed the App's change while neither is revoked.
    await vi.waitFor(() => {
      expect([toNotes.titles.at(-1), toOther.titles.at(-1)]).toStrictEqual([
        ["Before"],
        ["Before"],
      ]);
    }, pushWait);

    const events = await auditedDuring(async () => {
      await revoked(app, version);
      await client.mutation(second.api.create, { title: "After" });
      await vi.waitFor(() => {
        expect([toNotes.refused, toOther.titles.at(-1)]).toStrictEqual([
          ["page.revoked"],
          ["After", "Before"],
        ]);
      }, pushWait);
    });

    expect({
      toNotes: toNotes.titles,
      toNotesReleased: toNotes.state.released,
      toOther: toOther.titles,
      toOtherRefused: toOther.refused,
      refused: refusalsOf(events, app),
    }).toStrictEqual({
      // Never the change made after its release was revoked.
      toNotes: [[], ["Before"]],
      toNotesReleased: true,
      toOther: [[], ["Before"], ["After", "Before"]],
      toOtherRefused: [],
      // Refused by the gate, as the frame's build was.
      refused: [expect.stringMatching(liveRefusal)],
    });
  });

  it("lets go of what a closed frame followed, and refuses it, while the other frame of the same build goes on", async () => {
    const builder = await personApi("builder");
    const { app, api } = await twoPageApp(builder);
    const request = requestOf(api.list, { pagination: { pageSize: 10 } });
    const { pages } = builder.api;
    const notes = await pages.open(app);
    const closing = await pages.frame(app, notes.lease);
    // The same build in another frame: closing one is not closing both.
    const staying = await pages.frame(app, notes.lease);
    const toClosing = follower();
    const toStaying = follower();
    await closing.watchQuery(request, toClosing.callback);
    await staying.watchQuery(request, toStaying.callback);
    await vi.waitFor(() => {
      expect([toClosing.titles, toStaying.titles]).toStrictEqual([[[]], [[]]]);
    }, pushWait);

    await closing.close();
    await callingClient({ app, lease: notes.lease }, builder).mutation(
      api.create,
      { title: "After the close" }
    );

    await vi.waitFor(() => {
      expect(toStaying.titles.at(-1)).toStrictEqual(["After the close"]);
    }, pushWait);
    expect({
      toClosing: toClosing.titles,
      closingReleased: toClosing.state.released,
      stayingReleased: toStaying.state.released,
      closedFollow: await outcome(
        closing.watchQuery(request, follower().callback)
      ),
      closedDecision: await outcome(
        closing.reviewDecision("run-1", "review", { approved: true })
      ),
    }).toStrictEqual({
      toClosing: [[]],
      closingReleased: true,
      stayingReleased: false,
      closedFollow: "page.invalid",
      closedDecision: "page.invalid",
    });
  });

  it("follows nothing for a frame that closed while core admitted its live query", async () => {
    const builder = await personApi("builder");
    const { app, api } = await twoPageApp(builder);
    const request = requestOf(api.list, { pagination: { pageSize: 10 } });
    const { pages } = builder.api;
    const notes = await pages.open(app);
    const frame = await pages.frame(app, notes.lease);
    const toClosed = follower();

    // Sent one after the other: the close arrives while core still
    // admits the live query, which it lets go of as it is made.
    const following = outcome(frame.watchQuery(request, toClosed.callback));
    await frame.close();
    const answered = await following;

    await vi.waitFor(() => {
      expect(toClosed.state.released).toBeTruthy();
    }, pushWait);
    // A change after it: nothing follows it for the closed frame, while
    // an open frame's live query is pushed it.
    const toOpen = follower();
    const open = await pages.frame(app, notes.lease);
    await open.watchQuery(request, toOpen.callback);
    await callingClient({ app, lease: notes.lease }, builder).mutation(
      api.create,
      { title: "After the close" }
    );
    await vi.waitFor(() => {
      expect(toOpen.titles.at(-1)).toStrictEqual(["After the close"]);
    }, pushWait);
    expect({
      answered,
      pushedAfter: toClosed.titles.flat().includes("After the close"),
    }).toStrictEqual({ answered: "ok", pushedAfter: false });
  });

  it("answers a frame's delivery only to someone who still has a role in the App", async () => {
    const builder = await personApi("builder");
    const member = await personApi("builder");
    const { app } = await twoPageApp(builder);
    const them = { type: "person", id: member.userId } as const;
    await builder.api.apps.members.add(app, { ...them, role: "user" });
    const notes = await member.api.pages.open(app);
    const frame = await member.api.pages.frame(app, notes.lease);
    const before = await frame.delivery();

    await builder.api.apps.members.remove(app, them);

    expect({
      before,
      after: await pastAccessRecheck(
        async () => await outcome(frame.delivery())
      ),
    }).toStrictEqual({ before: "open", after: "app.not_found" });
  });
});

describe(
  "live queries of frames sharing a connection",
  { timeout: 120_000 },
  () => {
    it("lets go of a closed frame's live query at once, and keeps pushing the other frame's", async () => {
      const builder = await personApi("builder");
      const { app, version } = await currentApp(builder, notesFiles);
      const api = apiOf(await loadRelease(env, app, version));
      const { pages } = builder.api;
      const first = await pages.open(app);
      const second = await pages.open(app);
      const closing = await pages.frame(app, first.lease);
      const staying = await pages.frame(app, second.lease);
      const request = requestOf(api.list, { pagination: { pageSize: 10 } });
      const toClosing = follower();
      const toStaying = follower();
      await closing.watchQuery(request, toClosing.callback);
      await staying.watchQuery(request, toStaying.callback);
      await vi.waitFor(() => {
        expect([toClosing.titles, toStaying.titles]).toStrictEqual([
          [[]],
          [[]],
        ]);
      }, pushWait);

      await closing.close();
      await vi.waitFor(() => {
        expect(toClosing.state.released).toBeTruthy();
      }, pushWait);
      await callingClient({ app, lease: second.lease }, builder).mutation(
        api.create,
        { title: "After the close" }
      );

      await vi.waitFor(() => {
        expect(toStaying.titles.at(-1)).toStrictEqual(["After the close"]);
      }, pushWait);
      expect({
        closing: toClosing.titles,
        stayingReleased: toStaying.state.released,
      }).toStrictEqual({ closing: [[]], stayingReleased: false });
    });
  }
);
