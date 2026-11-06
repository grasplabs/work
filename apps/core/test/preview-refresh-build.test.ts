import { kitModuleName } from "@grasp-os/compiler";
import { appIdSchema } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { appDefinition } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { appModulesOf, loadFrame } from "./page-frames.ts";
import type { LoadedFrame } from "./page-frames.ts";
import { chatWithDraft } from "./previews.ts";
import { signedInApi } from "./sign-in.ts";

// The preview build profile (spec 19.2.1): a chat's preview of its draft
// runs its page instrumented for React Fast Refresh, on the preview kit
// (React's development builds and the Refresh runtime), while the App's
// published page, built from the same files, never carries any of it.
// The ways it can fail: Refresh code, its runtime or the preview kit
// reaching a production frame; a preview skipping the React Compiler; a
// component's family named by a revision or a hash, so a later update
// can't find it; and a preview's artifact passing for production's.

const idp = mockIdp();

const files = {
  ...appDefinition({ name: "Counter", tables: {} }),
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";

function Small() {
  const [count, setCount] = useState(0);
  return <Button onClick={() => setCount(count + 1)}>Clicked {count}</Button>;
}
export const Route = createFileRoute("/")({ component: Small });
`,
};

/** What only React Fast Refresh, its runtime or its instrumentation has. */
const refreshMarkers = [
  "__graspRefresh",
  "injectIntoGlobalHook",
  "performReactRefresh",
  kitModuleName("@grasp-os/sdk/preview-refresh"),
  // The receiver of a preview's updates (@grasp-os/sdk's preview-updates.ts).
  "The route tree's module has no routeTree.",
];

/** The preview kit's own modules, which a production frame never loads. */
const previewModules = [
  kitModuleName("@grasp-os/sdk/preview-refresh"),
  kitModuleName("@grasp-os/sdk/preview-runtime"),
];

/** What only React's development builds have. */
const developmentMarker = "Download the React DevTools";

/** The frame core serves for an opened page or preview. */
const framed = async (
  open: Promise<{ artifact: string; frameToken: string }>
): Promise<LoadedFrame> => {
  const frame = await loadFrame(await open);
  if (frame === null) {
    throw new Error("An opened page has a frame");
  }
  return frame;
};

/** The frame's page module, the App's `/`, as served. */
const entryOf = (frame: LoadedFrame): string =>
  frame.modules["app~src~routes~index.js"] ?? "";

/** Which of `markers` any of the frame's modules has. */
const found = (frame: LoadedFrame, markers: readonly string[]): string[] =>
  markers.filter((marker) =>
    Object.values(frame.modules).some((code) => code.includes(marker))
  );

describe("a chat's preview of its draft", { timeout: 60_000 }, () => {
  it("runs on the preview kit, instrumented for Fast Refresh, while the published page of the same files carries none of it", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Counter" });
    const app = appIdSchema.parse(id);
    await release(builder, app, files);
    const published = await framed(builder.api.pages.open(app));
    // The draft changes one word of the page.
    const { chatId } = await chatWithDraft(builder, app, {
      "src/routes/index.tsx": files["src/routes/index.tsx"].replace(
        "Clicked",
        "Pressed"
      ),
    });
    const preview = await framed(builder.api.chats.preview(chatId, app));

    expect({
      published: {
        runtime: published.page.runtime,
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
        runtime: preview.page.runtime,
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
        family: entryOf(preview).includes('"src/routes/index.tsx "+id'),
        registered: entryOf(preview).includes(',"Small")'),
        signed: entryOf(preview).includes('(Small,"useState{'),
        modules: appModulesOf(preview),
      },
      sameArtifact: preview.page.artifact === published.page.artifact,
    }).toStrictEqual({
      published: {
        runtime: kitModuleName("@grasp-os/sdk/page-runtime"),
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
        modules: [
          "app~src~routeTree.gen.js",
          "app~src~routes~__root.js",
          "app~src~routes~index.js",
        ],
      },
      sameArtifact: false,
    });
  });
});
