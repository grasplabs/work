// Each format's renderer, its own chunk, loaded only when a file of that kind opens. Kept apart from
// the shell so the box (artifact-viewer.tsx) can start the one a file will need at the same moment
// it starts the shell, rather than after it: the two load side by side.
//
// The core holds the HTML page, plain text, code (uncoloured) and images. A renderer item adds its own format when it
// is imported (`artifact-viewer-pdf`, `-csv`, `-markdown`; `artifact-viewer-code` adds code's colours;
// `artifact-viewer-all` imports them all). A format no installed item renders opens as a file the viewer cannot show here, with
// its download.
import type { ComponentType } from "react";

import type { ArtifactFormat } from "./format";
import type { RendererProps } from "./types";

export type RendererLoader = () => Promise<{
  default: ComponentType<RendererProps>;
}>;

export const RENDERER_LOADERS: Partial<Record<ArtifactFormat, RendererLoader>> =
  {
    text: async () => await import("./renderers/text/text"),
    // Code in lines; the code item adds Prism's colours. A web page's and a Markdown file's source
    // (their Code view) open in it too.
    code: async () => await import("./renderers/code/code"),
    image: async () => await import("./renderers/image/image"),
    html: async () => await import("./renderers/html/html"),
  };

/** Adds a format's renderer: an item calls it once, when it is imported. */
export const registerRenderer = (
  format: ArtifactFormat,
  loader: RendererLoader
) => {
  RENDERER_LOADERS[format] = loader;
};
