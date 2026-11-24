import type { Draft } from "@grasp-os/shared/drafts";
import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { PreviewFrame } from "../pages/page-frame.tsx";
import type { FrameFix, PageEnded } from "../pages/page-frame.tsx";
import type { ReadOnlyShown } from "./app-workspace.tsx";
import { previewWidths } from "./preview-controls.tsx";
import type { PreviewWidth } from "./preview-controls.tsx";

const styles = stylex.create({
  // The page's own ground, filling what is left of the workspace.
  preview: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: colors.background,
    width: "100%",
    marginInline: "auto",
  },
});

// The App being built, in its workspace (app-workspace.tsx): the compiled
// pages of the App's draft, as a preview, on the test data its builders
// share.

/**
 * The preview of App `app` as its `draft` has it: its pages, as one single
 * page app the person moves through as they would the App; of the draft's
 * checkpoint or the App's version `shown` when History opened one,
 * read-only. With no draft, or one that changes nothing, core previews
 * the App's latest version, so the App always shows. Each of the draft's
 * writes comes into the frame it has open, keeping what the pages hold
 * and the route they show, and starts afresh one that failed to start
 * (page-frame.tsx); another point or version starts it afresh, as its
 * key says.
 */
export const DraftPreview = ({
  app,
  at,
  width,
  draft,
  name,
  shown,
  onEnded,
  onRunning,
  onTestDataStale,
  onFix,
}: {
  app: string;
  /** The page it shows; its first while none was picked. */
  at?: string | undefined;
  /** How wide it is drawn. */
  width?: PreviewWidth;
  /** The App's draft; none until it is read. */
  draft: Draft | undefined;
  name: string;
  shown: ReadOnlyShown | undefined;
  /** Told once the frame failed (`PreviewFrame`). */
  onEnded?: PageEnded;
  /** Told each time its pages started and run (`PreviewFrame`). */
  onRunning?: () => void;
  /** Told its test data doesn't fit the draft's data model (`PreviewFrame`). */
  onTestDataStale?: () => void;
  /** Fix with Grasp, where the draft broke the preview (`PreviewFrame`). */
  onFix?: FrameFix;
}) => {
  const { t } = useLingui();
  const point =
    shown !== undefined && "point" in shown ? shown.point : undefined;
  const version =
    shown !== undefined && "version" in shown ? shown.version : undefined;
  return (
    <section
      aria-label={t`${name}, your version`}
      {...stylex.props(styles.preview, previewWidths[width ?? "desktop"])}
    >
      <PreviewFrame
        app={app}
        at={at}
        key={`${app}:${point ?? ""}:${version ?? ""}`}
        point={point}
        version={version}
        {...(draft === undefined ? {} : { revision: draft.revision })}
        {...(onEnded === undefined ? {} : { onEnded })}
        {...(onRunning === undefined ? {} : { onRunning })}
        {...(onTestDataStale === undefined ? {} : { onTestDataStale })}
        {...(onFix === undefined ? {} : { onFix })}
      />
    </section>
  );
};
