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
import { mockIdp } from "./idp.ts";
import { apiOf, notesFiles } from "./notes-client-app.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { outcome, routed, signedInApi } from "./sign-in.ts";

// A tab's App frames on the one connection they share (spec 11.2), each
// through its own way to its App (`screens.frame`), as the page's screen
// host runs them. Threat model, each tried below through core's real
// connection:
//
// - Frame A decided on frame B's build: two frames of one App on one
//   connection, each its own build; one build's approval taken back
//   stops that frame only, and a frame with no lease of core's never
//   borrows another frame's approval.
// - One frame's revocation reaching another's pushes: a callback each
//   frame passed its App's server; after one build's approval is taken
//   back, only the other frame's callback gets the App's pushes.
// - A closed frame following on: two frames follow the same live query
//   (one read shared between them); closing one lets go of its callback
//   at once, and the other is still pushed every change.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

const secret = "Acme owes 4,200";

const serverCode = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string };
type Watcher = ((notes: string[]) => Promise<void>) & Disposable & { dup(): Watcher };

export class App extends DurableObject {
  #watchers = new Set<Watcher>();

  notes(): string[] {
    return [${JSON.stringify(secret)}];
  }

  watchNotes(_caller: Caller, onChange: Watcher): void {
    this.#watchers.add(onChange.dup());
  }

  // Pushes the notes to whoever watches; answers how many took them.
  async pushNotes(): Promise<number> {
    let delivered = 0;
    for (const watcher of this.#watchers) {
      try {
        await watcher(this.notes());
        delivered += 1;
      } catch {
        this.#watchers.delete(watcher);
      }
    }
    return delivered;
  }
}
`;

const screenOf = (
  label: string
): string => `import { callServer } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";

export default function Screen() {
  return <Button onClick={() => void callServer("notes")}>${label}</Button>;
}
`;

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

/** Two screens, so two builds, each approved on its own. */
const twoScreenApp = async (builder: Person, admin: Person) =>
  await approvedApp(builder, admin, {
    "app/server.ts": serverCode,
    "screens/notes.tsx": screenOf("Notes"),
    "screens/other.tsx": screenOf("Other"),
  });

/** What a frame's App pushed to the callback it passed. */
const watcher = () => {
  const pushed: unknown[] = [];
  return {
    pushed,
    callback: (notes: unknown): void => {
      pushed.push(notes);
    },
  };
};

describe("frames sharing a tab's connection", { timeout: 120_000 }, () => {
  it("decides each frame on its own build, whatever another frame of the App on the connection runs", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { app } = await twoScreenApp(builder, admin);
    const { screens } = builder.api;
    const notes = await screens.open(app, "notes");
    const other = await screens.open(app, "other");
    const notesFrame = await screens.frame(app, notes.lease);
    // Made last, as the connection's last `present` would have been.
    const otherFrame = await screens.frame(app, other.lease);
    const unleased = await screens.frame(app, `${notes.artifact}.forged`);
    const before = await notesFrame.call("notes", []);

    await admin.api.screenTrust.revoke(app, notes.artifact);

    expect({
      before,
      notes: await outcome(notesFrame.call("notes", [])),
      notesDelivery: await notesFrame.delivery(),
      other: await otherFrame.call("notes", []),
      otherDelivery: await otherFrame.delivery(),
      unleased: await outcome(unleased.call("notes", [])),
      unleasedRuns: await outcome(unleased.runs("invoices")),
    }).toStrictEqual({
      before: [secret],
      notes: "screen.revoked",
      notesDelivery: "revoked",
      other: [secret],
      otherDelivery: "open",
      unleased: "screen.unreviewed",
      unleasedRuns: "screen.unreviewed",
    });
  });

  it("stops the pushes of a frame whose build lost its approval, and only that frame's", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { app } = await twoScreenApp(builder, admin);
    const { screens } = builder.api;
    const notes = await screens.open(app, "notes");
    const other = await screens.open(app, "other");
    const notesFrame = await screens.frame(app, notes.lease);
    const otherFrame = await screens.frame(app, other.lease);
    const toNotes = watcher();
    const toOther = watcher();
    await notesFrame.call("watchNotes", [toNotes.callback]);
    await otherFrame.call("watchNotes", [toOther.callback]);
    const bothWatch = await otherFrame.call("pushNotes", []);

    await admin.api.screenTrust.revoke(app, notes.artifact);
    const afterRevoke = await otherFrame.call("pushNotes", []);

    expect({
      bothWatch,
      afterRevoke,
      toNotes: toNotes.pushed,
      toOther: toOther.pushed,
    }).toStrictEqual({
      bothWatch: 2,
      afterRevoke: 1,
      toNotes: [[secret]],
      toOther: [[secret], [secret]],
    });
  });

  it("lets go of what a closed frame followed, and refuses it, while the other frame goes on", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { app } = await twoScreenApp(builder, admin);
    const { screens } = builder.api;
    const notes = await screens.open(app, "notes");
    const closing = await screens.frame(app, notes.lease);
    // The same build in another frame: closing one is not closing both.
    const staying = await screens.frame(app, notes.lease);
    const toClosing = watcher();
    const toStaying = watcher();
    await closing.call("watchNotes", [toClosing.callback]);
    await staying.call("watchNotes", [toStaying.callback]);

    await closing.close();

    expect({
      delivered: await staying.call("pushNotes", []),
      toClosing: toClosing.pushed,
      toStaying: toStaying.pushed,
      closedCall: await outcome(closing.call("notes", [])),
      closedFollow: await outcome(
        closing.watchRuns("invoices", () => {
          // Never followed.
        })
      ),
    }).toStrictEqual({
      delivered: 1,
      toClosing: [],
      toStaying: [[secret]],
      closedCall: "screen.invalid",
      closedFollow: "screen.invalid",
    });
  });

  it("lets go at once of a callback whose call was still being admitted when its frame closed", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { app } = await twoScreenApp(builder, admin);
    const { screens } = builder.api;
    const notes = await screens.open(app, "notes");
    const frame = await screens.frame(app, notes.lease);
    const state = { released: false };
    const callback = Object.assign(
      (): void => {
        // The App never pushes in this test.
      },
      {
        [Symbol.dispose]: (): void => {
          state.released = true;
        },
      }
    );

    // Sent one after the other: the close arrives while core still
    // admits the call, before the call hands its callback to the App.
    const call = outcome(frame.call("watchNotes", [callback]));
    await frame.close();
    const answered = await call;

    // Nothing is pushed: only the frame having closed lets go of it.
    await vi.waitFor(
      () => {
        expect(state.released).toBeTruthy();
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
      }
    },
    {
      [Symbol.dispose]: (): void => {
        state.released = true;
      },
    }
  );
  return { titles, state, callback };
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
