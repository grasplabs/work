import { kitModuleName } from "@grasp-os/compiler";
import { appIdSchema } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { chatWithDraft } from "./previews.ts";
import { appModulesOf, loadFrame } from "./screen-frames.ts";
import type { LoadedFrame } from "./screen-frames.ts";
import { signedInApi } from "./sign-in.ts";

// The preview build profile (spec 19.2.1): a chat's preview of its draft
// runs its screen instrumented for React Fast Refresh, on the preview kit
// (React's development builds and the Refresh runtime), while the App's
// published screen, built from the same files, never carries any of it.
// The ways it can fail: Refresh code, its runtime or the preview kit
// reaching a production frame; a preview skipping the React Compiler; a
// component's family named by a revision or a hash, so a later update
// can't find it; and a preview's artifact passing for production's.

const idp = mockIdp();

const files = {
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";

import schema from "./schema.ts";

export default app({
  name: "Counter",
  schema,
  access: { tables: {} },
  operations: {},
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
  "screens/small.tsx": `import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";

export default function Small() {
  const [count, setCount] = useState(0);
  return <Button onClick={() => setCount(count + 1)}>Clicked {count}</Button>;
}
`,
};

/** What only React Fast Refresh, its runtime or its instrumentation has. */
const refreshMarkers = [
  "__graspRefresh",
  "injectIntoGlobalHook",
  "performReactRefresh",
  kitModuleName("@grasp-os/sdk/preview-refresh"),
];

/** The preview kit's own modules, which a production frame never loads. */
const previewModules = [
  kitModuleName("@grasp-os/sdk/preview-refresh"),
  kitModuleName("@grasp-os/sdk/preview-runtime"),
];

/** What only React's development builds have. */
const developmentMarker = "Download the React DevTools";

/** The frame core serves for an opened screen or preview. */
const framed = async (
  open: Promise<{ artifact: string; frameToken: string }>
): Promise<LoadedFrame> => {
  const frame = await loadFrame(await open);
  if (frame === null) {
    throw new Error("An opened screen has a frame");
  }
  return frame;
};

/** The frame's screen module, as served. */
const entryOf = (frame: LoadedFrame): string =>
  frame.modules[frame.screen.entry] ?? "";

/** Which of `markers` any of the frame's modules has. */
const found = (frame: LoadedFrame, markers: readonly string[]): string[] =>
  markers.filter((marker) =>
    Object.values(frame.modules).some((code) => code.includes(marker))
  );

describe("a chat's preview of its draft", { timeout: 60_000 }, () => {
  it("runs on the preview kit, instrumented for Fast Refresh, while the published screen of the same files carries none of it", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Counter" });
    const app = appIdSchema.parse(id);
    await release(builder, app, files);
    const published = await framed(builder.api.screens.open(app, "small"));
    // The draft changes one word of the screen.
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/small.tsx": files["screens/small.tsx"].replace(
        "Clicked",
        "Pressed"
      ),
    });
    const preview = await framed(
      builder.api.chats.preview(chatId, app, "small")
    );

    expect({
      published: {
        runtime: published.screen.runtime,
        refresh: found(published, refreshMarkers),
        previewModules: previewModules.filter((name) =>
          Object.hasOwn(published.modules, name)
        ),
        development: found(published, [developmentMarker]),
        compiled: entryOf(published).includes(
          kitModuleName("react/compiler-runtime")
        ),
      },
      preview: {
        runtime: preview.screen.runtime,
        refresh: found(preview, refreshMarkers),
        previewModules: previewModules.filter((name) =>
          Object.hasOwn(preview.modules, name)
        ),
        development: found(preview, [developmentMarker]),
        // Still through the React Compiler, which resets a component's
        // memo cache when its source changes.
        compiled: entryOf(preview).includes(
          kitModuleName("react/compiler-runtime")
        ),
        // By its file and its name, never a revision or a hash.
        family: entryOf(preview).includes('"screens/small.tsx "+id'),
        registered: entryOf(preview).includes(',"Small")'),
        signed: entryOf(preview).includes('(Small,"useState{'),
        modules: appModulesOf(preview),
      },
      sameArtifact: preview.screen.artifact === published.screen.artifact,
    }).toStrictEqual({
      published: {
        runtime: kitModuleName("@grasp-os/sdk/screen-runtime"),
        refresh: [],
        previewModules: [],
        development: [],
        compiled: true,
      },
      preview: {
        runtime: kitModuleName("@grasp-os/sdk/preview-runtime"),
        refresh: refreshMarkers,
        previewModules,
        development: [developmentMarker],
        compiled: true,
        family: true,
        registered: true,
        signed: true,
        modules: [preview.screen.entry],
      },
      sameArtifact: false,
    });
  });
});
