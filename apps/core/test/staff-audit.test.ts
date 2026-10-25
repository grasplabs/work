import { appFilesPath } from "@grasp-os/shared/app-file-limits";
import { appLinksPath } from "@grasp-os/shared/app-link-limits";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { auditExportPath } from "@grasp-os/shared/audit-log";
import { connectionCallbackPath } from "@grasp-os/shared/connect";
import { errorReportPath } from "@grasp-os/shared/error-reports";
import { appIdSchema } from "@grasp-os/shared/ids";
import { labPath } from "@grasp-os/shared/lab";
import { appTokenPath } from "@grasp-os/shared/portable";
import {
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screen-limits";
import { uploadOriginalPath } from "@grasp-os/shared/uploads";
import { speechPath, transcriptionPath } from "@grasp-os/shared/voice";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import worker from "../src/index.ts";
import { CoreRpcTarget } from "../src/rpc-target.ts";
import { ScreenFrameRpc } from "../src/screens-rpc.ts";
import { SessionRpc } from "../src/session-rpc.ts";
import { staffAudited } from "../src/staff-audit.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote } from "./knowledge.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  whoami,
} from "./sign-in.ts";

// Every view and action of Grasp's staff is in the client's audit log
// (GRA-1087, its threat model): staff may read everything, and each read,
// over `/rpc` or a route, writes one entry the client's admins see, as
// "(Grasp staff)", naming what was viewed and never what it holds. The
// ways it can fail, tried here:
// 1. A surface reads for staff and writes no entry.
// 2. A page asking again floods the log, or a view of something else is
//    folded into another's entry.
// 3. An entry repeats what was read: a search's terms, a document's text.
// 4. A person who isn't staff writes staff entries.

const idp = mockIdp();

/** A staff session and its API, on a connection of its own. */
const staffOn = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return { session, api: core.authenticate() };
};

/** The staff entries among `events`. */
const staffViews = (events: readonly AuditEvent[]): AuditEvent[] =>
  events.filter(({ action }) => action === "staff.accessed");

/** The surface each staff entry among `events` names. */
const surfacesOf = (events: readonly AuditEvent[]): unknown[] =>
  staffViews(events).map(({ detail }) => detail.surface);

/** How long the walk waits for one call before it goes on. */
const callWaitMs = 3000;

/**
 * Every method of `target` and of every target its getters hand out, by
 * path, each as a call with no arguments: what a browser can call.
 */
const targetMethods = (
  target: object,
  path: string,
  seen = new Set<object>()
): { name: string; call: () => unknown }[] => {
  if (seen.has(target)) {
    return [];
  }
  seen.add(target);
  const found: { name: string; call: () => unknown }[] = [];
  for (
    let prototype: object | null = Reflect.getPrototypeOf(target);
    prototype !== null && prototype !== CoreRpcTarget.prototype;
    prototype = Reflect.getPrototypeOf(prototype)
  ) {
    for (const key of Reflect.ownKeys(prototype)) {
      const property = Reflect.getOwnPropertyDescriptor(prototype, key);
      if (typeof key !== "string" || key === "constructor" || !property) {
        continue;
      }
      const name = `${path}.${key}`;
      if (property.get !== undefined) {
        const inner: unknown = Reflect.apply(property.get, target, []);
        if (inner instanceof CoreRpcTarget) {
          found.push(...targetMethods(inner, name, seen));
        }
      } else if (typeof property.value === "function") {
        const method: unknown = property.value;
        found.push({
          name,
          call: (): unknown => {
            if (typeof method !== "function") {
              return undefined;
            }
            const answer: unknown = Reflect.apply(method, target, []);
            return answer;
          },
        });
      }
    }
  }
  return found;
};

/** A text that must never reach the log. */
const secret = `Salary${crypto.randomUUID().slice(0, 8)}`;

describe("Grasp staff's views, audited", () => {
  it("write one entry for each read, over /rpc or a route, without content", async () => {
    const admin = await signedInApi(idp, "admin");
    const { noteId } = await collectionWithNote(admin.api, {
      name: `Handbook ${secret}`,
      access: "everyone",
    });
    const { session, api } = await staffOn();
    const { userId } = await api.whoami();
    const uploadId = crypto.randomUUID();
    const app = crypto.randomUUID();
    const reads: [string, () => Promise<unknown>][] = [
      [
        "knowledge.listCollections",
        async () => await api.knowledge.listCollections(),
      ],
      ["knowledge.search", async () => await api.knowledge.search(secret)],
      [
        "knowledge.getDocument",
        async () => await api.knowledge.getDocument(noteId),
      ],
      ["memory.collections", async () => await api.memory.collections()],
      ["brain.notes", async () => await api.brain.notes()],
      ["chats.list", async () => await api.chats.list()],
      ["decisions.waiting", async () => await api.decisions.waiting()],
      ["audit.search", async () => await api.audit.search()],
      ["workflows.runs", async () => await api.workflows.runs()],
      [
        "screenSubmissions.list",
        async () => await api.screenSubmissions.list(),
      ],
      [
        "audit.export",
        async () =>
          await routed(`${auditExportPath}?format=csv`, {
            headers: { cookie: session },
          }),
      ],
      [
        "uploads.original",
        async () =>
          await routed(uploadOriginalPath(uploadId), {
            headers: { cookie: session },
          }),
      ],
      [
        "app.files",
        async () =>
          await routed(`${appFilesPath}/${app}/notes/files/f1`, {
            headers: { cookie: session, [screenLeaseHeader]: "lease" },
          }),
      ],
      [
        "app.link.check",
        async () =>
          await routed(`${appLinksPath}/${app}/links/check`, {
            method: "POST",
            headers: {
              cookie: session,
              origin: clientOrigin,
              "content-type": "application/json",
              [screenLeaseHeader]: "lease",
            },
            body: JSON.stringify({}),
          }),
      ],
      [
        "app.token",
        async () =>
          await routed(`${appTokenPath}/${app}`, {
            method: "POST",
            headers: {
              cookie: session,
              origin: clientOrigin,
              "content-type": "application/json",
            },
            body: "{}",
          }),
      ],
      [
        "connections.callback",
        async () =>
          await routed(`${connectionCallbackPath}?state=staff-probe`, {
            headers: { cookie: session },
          }),
      ],
      [
        "error.report",
        async () =>
          await routed(errorReportPath, {
            method: "POST",
            headers: {
              cookie: session,
              origin: clientOrigin,
              "content-type": "application/json",
            },
            body: "{}",
          }),
      ],
      [
        "onboarding.lab",
        async () =>
          await worker.fetch(
            new Request(`http://localhost:8787${labPath}`, {
              method: "POST",
              headers: { "content-type": "application/json", cookie: session },
              body: "{}",
            }),
            { ...env, DEV_SKIP_ROUTER_SECRET: "true" },
            createExecutionContext()
          ),
      ],
      [
        "onboarding.speech",
        async () =>
          await routed(speechPath, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: session },
            body: JSON.stringify({ text: "Hello.", language: "en" }),
          }),
      ],
      [
        "onboarding.transcription",
        async () => {
          const response = await routed(transcriptionPath, {
            headers: {
              Upgrade: "websocket",
              Origin: clientOrigin,
              cookie: session,
            },
          });
          const socket = response.webSocket;
          if (socket === null) {
            throw new Error(`Expected a WebSocket, got ${response.status}`);
          }
          const answered = Promise.withResolvers<null>();
          socket.addEventListener("message", () => {
            answered.resolve(null);
          });
          socket.addEventListener("close", () => {
            answered.resolve(null);
          });
          socket.accept();
          // Who listens is read once the page says how it will talk.
          socket.send(
            JSON.stringify({
              type: "start",
              language: "en",
              sampleRate: 16_000,
            })
          );
          await Promise.race([answered.promise, scheduler.wait(callWaitMs)]);
          socket.close();
        },
      ],
      [
        "app.functions",
        async () =>
          await routed(`/api/app-functions/${app}`, {
            method: "POST",
            headers: {
              cookie: session,
              origin: clientOrigin,
              "content-type": "application/json",
              [screenPersonHeader]: userId,
            },
            body: JSON.stringify({}),
          }),
      ],
    ];
    const written: Record<string, unknown[]> = {};
    const all: AuditEvent[] = [];
    for (const [surface, read] of reads) {
      // oxlint-disable-next-line no-await-in-loop -- one read, then its entries
      const events = await auditedDuring(
        async () => {
          await outcome(read());
        },
        { staffAccesses: true }
      );
      written[surface] = surfacesOf(events);
      all.push(...staffViews(events));
    }
    const seen = await admin.api.audit.search({ action: "staff.accessed" });

    expect(written).toStrictEqual(
      Object.fromEntries(reads.map(([surface]) => [surface, [surface]]))
    );
    expect({
      actors: [...new Set(all.map(({ actor }) => actor.type))],
      document: all.find(
        ({ detail }) => detail.surface === "knowledge.getDocument"
      )?.provenance,
      upload: all.find(({ detail }) => detail.surface === "uploads.original")
        ?.provenance,
      content: JSON.stringify(all).includes(secret),
      // The client's admins read them in their own log.
      visible: all.every(({ id }) =>
        seen.records.some(({ event }) => event?.id === id)
      ),
    }).toStrictEqual({
      actors: ["staff"],
      document: [noteId],
      upload: [uploadId],
      content: false,
      visible: true,
    });
  });

  it("write the same view once a window, and every other view apart", async () => {
    const admin = await signedInApi(idp, "admin");
    const first = await collectionWithNote(admin.api, {
      name: "First",
      access: "everyone",
    });
    const second = await collectionWithNote(admin.api, {
      name: "Second",
      access: "everyone",
    });
    const { api } = await staffOn();
    await api.whoami();

    const events = await auditedDuring(
      async () => {
        for (let time = 0; time < 5; time += 1) {
          // oxlint-disable-next-line no-await-in-loop -- a page asking again
          await api.knowledge.getDocument(first.noteId);
        }
        await api.knowledge.getDocument(second.noteId);
      },
      { staffAccesses: true }
    );

    expect(
      staffViews(events).map(({ detail, provenance }) => [
        detail.surface,
        provenance,
      ])
    ).toStrictEqual([
      ["knowledge.getDocument", [first.noteId]],
      ["knowledge.getDocument", [second.noteId]],
    ]);
  });

  it("name an argument that isn't a platform ID by its kind alone, and tell distinct asks apart", async () => {
    const { api } = await staffOn();
    await api.whoami();
    const asked = [
      "salary_review",
      "anna_de_vries",
      `sk_live_${"4eC39HqLyjWDarjtT1zdp7dc".repeat(2)}`,
      `ghp_${"16C7e42F292c6912E7710c838347Ae178B4a".slice(0, 36)}`,
    ];

    const events = await auditedDuring(
      async () => {
        for (const query of asked) {
          // oxlint-disable-next-line no-await-in-loop -- one ask after another
          await api.knowledge.search(query);
        }
      },
      { staffAccesses: true }
    );
    const views = staffViews(events);

    expect({
      entries: views.map(({ detail, provenance }) => [
        detail.surface,
        detail.kinds,
        provenance,
      ]),
      leaked: asked.filter((query) => JSON.stringify(views).includes(query)),
    }).toStrictEqual({
      entries: asked.map(() => ["knowledge.search", "query", []]),
      leaked: [],
    });
  });

  it("never name a roster person's ID on any of the onboarding's methods, only kinds", async () => {
    const { api } = await staffOn();
    await api.whoami();
    const person = crypto.randomUUID();

    const events = await auditedDuring(
      async () => {
        await outcome(api.onboardingStaff.newStart(person));
        await outcome(api.onboardingStaff.sendMailAgain(person));
        await outcome(api.onboardingStaff.remind([person]));
        await outcome(api.onboardingStaff.deleteInterview(person));
        await outcome(api.onboardingStaff.interview(person));
      },
      { staffAccesses: true }
    );
    const views = staffViews(events);

    expect({
      surfaces: views.map(({ detail }) => detail.surface),
      named: JSON.stringify(views).includes(person),
    }).toStrictEqual({
      surfaces: [
        "onboardingStaff.newStart",
        "onboardingStaff.sendMailAgain",
        "onboardingStaff.remind",
        "onboardingStaff.deleteInterview",
        "onboardingStaff.interview",
      ],
      named: false,
    });
  });

  it("write the same view asked at once only once, and the same method of two targets apart", async () => {
    const admin = await signedInApi(idp, "admin");
    const { noteId } = await collectionWithNote(admin.api, {
      name: "Parallel",
      access: "everyone",
    });
    const { api } = await staffOn();
    await api.whoami();
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const staff = await whoami(session);
    const check = staffAudited(env, async () => await Promise.resolve(staff));
    const frames = [crypto.randomUUID(), crypto.randomUUID()].map(
      (app) =>
        new ScreenFrameRpc({
          env,
          check,
          userId: staff.userId,
          app: appIdSchema.parse(app),
          build: undefined,
          stillOpen: () => async () => await Promise.resolve(false),
          // SAFETY: never reached: the Apps don't exist, so no call goes
          // past its check to follow a query or read a standing.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          queries: {} as never,
          runSubscriptions: new Set(),
          // SAFETY: never reached either, as for `queries`.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          standingNow: async () => await Promise.resolve({} as never),
        })
    );

    const events = await auditedDuring(
      async () => {
        await Promise.all(
          Array.from(
            { length: 5 },
            async () => await api.knowledge.getDocument(noteId)
          )
        );
        for (const frame of frames) {
          // oxlint-disable-next-line no-await-in-loop -- one frame, then the other
          await outcome(frame.delivery());
        }
      },
      { staffAccesses: true }
    );

    expect(
      staffViews(events).map(({ detail }) => detail.surface)
    ).toStrictEqual([
      "knowledge.getDocument",
      "screenFrame.delivery",
      "screenFrame.delivery",
    ]);
  });

  it("write no staff entry for an admin who isn't staff", async () => {
    const admin = await signedInApi(idp, "admin");
    const { noteId } = await collectionWithNote(admin.api, {
      name: "Handbook",
      access: "everyone",
    });

    const events = await auditedDuring(
      async () => {
        await admin.api.knowledge.getDocument(noteId);
        await admin.api.knowledge.search("handbook");
        await admin.api.chats.list();
        await routed(`${auditExportPath}?format=csv`, {
          headers: { cookie: admin.session },
        });
      },
      { staffAccesses: true }
    );

    expect(staffViews(events)).toStrictEqual([]);
  });

  it("write an entry for a call of every method of every namespace", async () => {
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const staff = await whoami(session);
    const api = new SessionRpc(
      env,
      async () => await Promise.resolve(staff),
      crypto.randomUUID()
    );
    const calls = targetMethods(api, "session");
    const unaudited: string[] = [];
    for (const { name, call } of calls) {
      // oxlint-disable-next-line no-await-in-loop -- one call, then its entry
      const events = await auditedDuring(
        async () => {
          await Promise.race([
            outcome(Promise.resolve().then(call)),
            scheduler.wait(callWaitMs),
          ]);
        },
        { staffAccesses: true }
      );
      const method = name.split(".").at(-1) ?? "";
      if (
        !staffViews(events).some(({ detail }) =>
          String(detail.surface).endsWith(`.${method}`)
        )
      ) {
        unaudited.push(name);
      }
    }

    expect(calls.length).toBeGreaterThan(100);
    expect(unaudited).toStrictEqual([]);
  });

  it("write an entry for a call of every method of a target a call hands out: a screen's frame", async () => {
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const staff = await whoami(session);
    const frame = new ScreenFrameRpc({
      env,
      check: staffAudited(env, async () => await Promise.resolve(staff)),
      userId: staff.userId,
      app: appIdSchema.parse(crypto.randomUUID()),
      build: undefined,
      stillOpen: () => async () => await Promise.resolve(false),
      // SAFETY: never reached: every call is checked first, and the App
      // doesn't exist, so none follows a query or reads a standing.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      queries: {} as never,
      runSubscriptions: new Set(),
      // SAFETY: never reached either, as for `queries`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      standingNow: async () => await Promise.resolve({} as never),
    });
    // Closing lets go of what the frame follows: it reads and changes
    // nothing of the client's.
    const calls = targetMethods(frame, "frame").filter(
      ({ name }) => name !== "frame.close"
    );
    const unaudited: string[] = [];
    for (const { name, call } of calls) {
      // oxlint-disable-next-line no-await-in-loop -- one call, then its entry
      const events = await auditedDuring(
        async () => {
          await Promise.race([
            outcome(Promise.resolve().then(call)),
            scheduler.wait(callWaitMs),
          ]);
        },
        { staffAccesses: true }
      );
      const method = name.split(".").at(-1) ?? "";
      if (
        !staffViews(events).some(({ detail }) =>
          String(detail.surface).endsWith(`.${method}`)
        )
      ) {
        unaudited.push(name);
      }
    }

    expect(calls.length).toBeGreaterThan(5);
    expect(unaudited).toStrictEqual([]);
  });
});
