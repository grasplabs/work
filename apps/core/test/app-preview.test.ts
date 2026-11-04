import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { chatWithDraft } from "./previews.ts";
import { signedInApi } from "./sign-in.ts";

// A chat's preview of its draft of an App: the draft's screens and server
// code, run for the chat's person with no side effects. These tests start
// from the ways it can fail: the draft's code writes to the App's real
// storage or Knowledge, calls a connection or another App, records a
// statistic, reaches the network, or reads real data it could show; a
// name a permission asked for and not granted gives the preview reaches
// what only a grant allows; a preview keeps what an earlier draft wrote;
// and someone other than the chat's person, or a person who no longer
// builds the App, previews it.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const screen = `export default function Desk() {
  return <main>Desk</main>;
}
`;

/** The App as released: a screen. */
const released = {
  "screens/desk.tsx": screen,
};

/** A new App of `builder`'s, released. */
const newApp = async (
  builder: Person,
  name: string,
  files: Record<string, string>
): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name });
  await release(builder, id, files);
  return appIdSchema.parse(id);
};

/** What a call answered, or the code of the error it failed with. */
const answer = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : String(error);
  }
};

describe("previewing a chat's draft", { timeout: 120_000 }, () => {
  it("says which of its paths a draft deletes, and previews no screen it deleted", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/desk.tsx": null,
      "screens/list.tsx": screen,
    });
    const { chats } = builder.api;

    const [draft] = await chats.drafts(chatId);
    const first = await chats.preview(chatId, app);

    expect({
      changed: draft?.changed,
      deleted: draft?.deleted,
      first: { screen: first.screen, screens: first.screens },
      gone: await answer(chats.preview(chatId, app, "desk")),
    }).toStrictEqual({
      changed: ["screens/desk.tsx", "screens/list.tsx"],
      deleted: ["screens/desk.tsx"],
      first: { screen: "list", screens: ["list"] },
      gone: "screen.not_found",
    });
  });
});
