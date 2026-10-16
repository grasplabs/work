import type { OperationReference, ReferenceKind } from "@grasp-os/sdk";
import { GraspClient } from "@grasp-os/sdk/host";
import type { ClientTransport } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type { Role } from "@grasp-os/shared/roles";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { pastAccessRecheck } from "./apps.ts";
import { approvalApp } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { apiOf, notesFiles } from "./notes-client-app.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { auditedDuring, outcome, routed, signedInApi } from "./sign-in.ts";

// A tab's App frames on the one connection they share (spec 11.2), each
// through its own way to its App (`screens.frame`), as the page's screen
// host runs them. Threat model, each tried below through core's real
// connection:
//
// - Frame A decided on frame B's build: two frames of one App on one
//   connection, each its own build; one build's approval taken back
//   stops that frame only, and a frame with no lease of core's never
//   borrows another frame's approval.
// - One frame's revocation reaching another's pushes: each frame follows
//   the App's notes (`watchQuery`); after one build's approval is taken
//   back, only the other frame is pushed the App's changes.
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

/** Approves the App's current screens as `admin`, exactly as reviewed. */
const approveCurrent = async (admin: Person, app: string): Promise<void> => {
  const { version, generation, screens } =
    await admin.api.screenTrust.review(app);
  await admin.api.screenTrust.approve(app, {
    version,
    generation,
    artifacts: builtArtifacts(screens),
  });
};

/** A new App with `files` as its current version, its screens approved. */
const approvedApp = async (
  builder: Person,
  admin: Person,
  files: Record<string, string>
) => {
  const { id } = await builder.api.apps.create({ name: "Notes" });
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  await approveCurrent(admin, id);
  return { app: id, version };
};

/**
 * Two screens, so two builds, each approved on its own; and the App's
 * `api`, as they call it.
 */
const twoScreenApp = async (builder: Person, admin: Person) => {
  const notesScreen = notesFiles["screens/notes.tsx"] ?? "";
  const { app, version } = await approvedApp(builder, admin, {
    ...notesFiles,
    "screens/other.tsx": notesScreen.replace(">Add<", ">Other<"),
  });
  return { app, api: apiOf(await loadRelease(env, app, version)) };
};

/** A page's callback that is never pushed to, and whether core let go of it. */
const releasable = () => {
  const state = { released: false };
  const callback = Object.assign(
    (): void => {
      // Nothing is pushed to it.
    },
    {
      [Symbol.dispose]: (): void => {
        state.released = true;
      },
    }
  );
  return { state, callback };
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
 * A live query's refusal of a build taken back, recorded by whichever
 * check meets it first: its read (`admission`) or the push of what it
 * read (`push`).
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
  reference: OperationReference<unknown, unknown, ReferenceKind>,
  input: unknown
): string =>
  JSON.stringify({
    reference: {
      resourceId: reference.resourceId,
      resourceVersion: reference.resourceVersion,
      contractId: reference.contractId,
      fingerprint: reference.fingerprint,
      kind: reference.kind,
    },
    input,
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
          [screenLeaseHeader]: lease,
          [screenPersonHeader]: person.userId,
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
    const admin = await personApi("admin");
    const { app, api } = await twoScreenApp(builder, admin);
    const request = requestOf(api.list, { pagination: { pageSize: 10 } });
    const { screens } = builder.api;
    const notes = await screens.open(app, "notes");
    const other = await screens.open(app, "other");
    const notesFrame = await screens.frame(app, notes.lease);
    // Made last, as the connection's last `present` would have been.
    const otherFrame = await screens.frame(app, other.lease);
    const unleased = await screens.frame(app, `${notes.artifact}.forged`);
    const beforeFollower = follower();
    const before = await outcome(
      notesFrame.watchQuery(request, beforeFollower.callback)
    );

    // Its first read done before the revocation: nothing of it is left
    // to refuse while what follows is recorded, as nothing changes.
    await vi.waitFor(() => {
      expect(beforeFollower.titles).toStrictEqual([[]]);
    }, pushWait);

    await admin.api.screenTrust.revoke(app, notes.artifact);

    let after: Record<string, unknown> = {};
    const events = await auditedDuring(async () => {
      after = {
        notes: await outcome(
          notesFrame.watchQuery(request, follower().callback)
        ),
        notesRuns: await outcome(notesFrame.runs("invoices")),
        notesDelivery: await notesFrame.delivery(),
        other: await outcome(
          otherFrame.watchQuery(request, follower().callback)
        ),
        otherDelivery: await otherFrame.delivery(),
        unleased: await outcome(
          unleased.watchQuery(request, follower().callback)
        ),
        unleasedRuns: await outcome(unleased.runs("invoices")),
      };
    });

    expect({ before, after, refused: refusalsOf(events, app) }).toStrictEqual({
      before: "ok",
      after: {
        notes: "screen.revoked",
        notesRuns: "screen.revoked",
        notesDelivery: "revoked",
        other: "ok",
        otherDelivery: "open",
        unleased: "screen.unreviewed",
        unleasedRuns: "screen.unreviewed",
      },
      // Each refused by the trust gate, as its own frame's build.
      refused: [
        "runs/admission: revoked",
        "runs/admission: unreviewed",
        "watchQuery/admission: revoked",
        "watchQuery/admission: unreviewed",
      ],
    });
  });

  it("stops the pushes of a frame whose build lost its approval, and only that frame's", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { app, api } = await twoScreenApp(builder, admin);
    const request = requestOf(api.list, { pagination: { pageSize: 10 } });
    const { screens } = builder.api;
    const notes = await screens.open(app, "notes");
    const other = await screens.open(app, "other");
    const notesFrame = await screens.frame(app, notes.lease);
    const otherFrame = await screens.frame(app, other.lease);
    const toNotes = follower();
    const toOther = follower();
    await notesFrame.watchQuery(request, toNotes.callback);
    await otherFrame.watchQuery(request, toOther.callback);
    const client = callingClient({ app, lease: other.lease }, builder);
    await client.mutation(api.create, { title: "Before" });
    // Both frames are pushed the App's change while both are approved.
    await vi.waitFor(() => {
      expect([toNotes.titles.at(-1), toOther.titles.at(-1)]).toStrictEqual([
        ["Before"],
        ["Before"],
      ]);
    }, pushWait);

    const events = await auditedDuring(async () => {
      await admin.api.screenTrust.revoke(app, notes.artifact);
      await client.mutation(api.create, { title: "After" });
      await vi.waitFor(() => {
        expect([toNotes.refused, toOther.titles.at(-1)]).toStrictEqual([
          ["screen.revoked"],
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
      // Never the change made after its approval was taken back.
      toNotes: [[], ["Before"]],
      toNotesReleased: true,
      toOther: [[], ["Before"], ["After", "Before"]],
      toOtherRefused: [],
      // Refused by the trust gate, as the frame's build was.
      refused: [expect.stringMatching(liveRefusal)],
    });
  });

  it("lets go of what a closed frame followed, and refuses it, while the other frame of the same build goes on", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { app, api } = await twoScreenApp(builder, admin);
    const request = requestOf(api.list, { pagination: { pageSize: 10 } });
    const { screens } = builder.api;
    const notes = await screens.open(app, "notes");
    const closing = await screens.frame(app, notes.lease);
    // The same build in another frame: closing one is not closing both.
    const staying = await screens.frame(app, notes.lease);
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
      closedRuns: await outcome(
        closing.watchRuns("invoices", () => {
          // Never followed.
        })
      ),
    }).toStrictEqual({
      toClosing: [[]],
      closingReleased: true,
      stayingReleased: false,
      closedFollow: "screen.invalid",
      closedRuns: "screen.invalid",
    });
  });

  it("follows nothing for a frame that closed while core admitted its live query", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { app, api } = await twoScreenApp(builder, admin);
    const request = requestOf(api.list, { pagination: { pageSize: 10 } });
    const { screens } = builder.api;
    const notes = await screens.open(app, "notes");
    const frame = await screens.frame(app, notes.lease);
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
    const open = await screens.frame(app, notes.lease);
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

  it("lets go at once of what a frame that closed while core opened it follows", async () => {
    const builder = await personApi("builder");
    const app = await approvalApp(builder);
    // No lease of core's: the App's data allows any build here.
    const frame = await builder.api.screens.frame(app, "");
    const toClosed = releasable();

    // Sent one after the other: the close arrives while core still
    // admits the follow, or waits for the App's host to take it.
    const following = outcome(frame.watchRuns("approval", toClosed.callback));
    await frame.close();
    const answered = await following;

    // Nothing is pushed: only the frame having closed lets go of it.
    await vi.waitFor(
      () => {
        expect(toClosed.state.released).toBeTruthy();
      },
      { timeout: 5000, interval: 50 }
    );
    expect(answered).toBe("ok");
  });

  it("answers a frame's delivery only to someone who still has a role in the App", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const member = await personApi("builder");
    const { app } = await twoScreenApp(builder, admin);
    const them = { type: "person", id: member.userId } as const;
    await builder.api.apps.members.add(app, { ...them, role: "user" });
    const notes = await member.api.screens.open(app, "notes");
    const frame = await member.api.screens.frame(app, notes.lease);
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
      const admin = await personApi("admin");
      const { app, version } = await approvedApp(builder, admin, notesFiles);
      const api = apiOf(await loadRelease(env, app, version));
      const { screens } = builder.api;
      const first = await screens.open(app, "notes");
      const second = await screens.open(app, "notes");
      const closing = await screens.frame(app, first.lease);
      const staying = await screens.frame(app, second.lease);
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
