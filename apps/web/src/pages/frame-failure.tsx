import { Button } from "@grasp-os/ui/components/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@grasp-os/ui/components/code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Icon,
  LogOutIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import type { FailureReason, PageState } from "./page-host.ts";

// What an App's frame shows in place of its page once the page failed
// or its person signed out (page-frame.tsx): a failed page where the page
// would be, what happened as its heading,
// one plain sentence why, Try again, and for a preview its draft broke,
// Fix with Grasp, which asks the App's chat. What core or the browser said
// is there too, folded away, for whoever wants it. No line on whether
// Grasp can be reached: a preview keeps a connection of its own, which the
// tab's does not speak for.

const styles = stylex.create({
  actions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space[2],
  },
  // The fold runs the width of the words above it.
  fold: { width: "100%", textAlign: "start" },
});

const titles: Readonly<Record<FailureReason, MessageDescriptor>> = {
  forbidden: msg`You can't open this App`,
  "not-found": msg`This page doesn't exist`,
  "not-running": msg`Nothing to run yet`,
  broken: msg`This page couldn't load`,
  "timed-out": msg`This page didn't start`,
  left: msg`This page was stopped`,
  disconnected: msg`This page lost its connection`,
  unreviewed: msg`This page couldn't be checked`,
  revoked: msg`This version was revoked`,
  "principal-changed": msg`Someone else signed in`,
  corrupt: msg`This page couldn't load`,
  "not-sealed": msg`This version can't open`,
  "version-revoked": msg`This version was revoked`,
  outdated: msg`This version can't open`,
  unsupported: msg`This browser is too old`,
  unknown: msg`This page couldn't load`,
};

const reasons: Readonly<Record<FailureReason, MessageDescriptor>> = {
  forbidden: msg`You can't open this App's pages: your role doesn't allow it, or the App has read data you can't read.`,
  "not-found": msg`This App has no such page.`,
  "not-running": msg`This App has no version to run yet.`,
  broken: msg`This page doesn't build. Ask a builder to fix it.`,
  "timed-out": msg`It took too long to start: the connection may be slow, or the page never finished drawing.`,
  left: msg`This page left its frame and was stopped.`,
  disconnected: msg`This page lost its connection to Grasp and was stopped.`,
  unreviewed: msg`Grasp couldn't confirm this page's code for you. Reload to try again.`,
  revoked: msg`This version of the App was revoked, and the page was stopped. A builder can publish another version from History.`,
  "principal-changed": msg`Someone else signed in on this browser, so this page was stopped. Try again to open it as the person signed in now.`,
  corrupt: msg`This page's stored code no longer matches the code that was published, so it wasn't opened. Tell an admin.`,
  "not-sealed": msg`This version of the App hasn't been sealed, so it can't be opened. A builder can publish it again.`,
  "version-revoked": msg`This version of the App was revoked and no longer runs. A builder can publish another version from History.`,
  outdated: msg`This version of the App was published before a Grasp update and no longer runs. A builder can publish the App again.`,
  unsupported: msg`This browser is too old for App pages. Update it, or open this page in a current Chrome, Edge, Firefox or Safari.`,
  unknown: msg`Something went wrong while it opened.`,
};

/** What a preview's draft broke, rather than the browser or someone's access. */
const draftFailures: ReadonlySet<FailureReason> = new Set([
  "broken",
  "timed-out",
  "not-found",
  "disconnected",
  "unknown",
]);

/** Whether the draft in a preview caused `reason`: Grasp can fix it. */
const fromTheDraft = (reason: FailureReason): boolean =>
  draftFailures.has(reason);

/** Failures of a preview said as the preview's rather than a page's. */
const previewStarts: ReadonlySet<FailureReason> = new Set([
  "broken",
  "timed-out",
  "unknown",
]);

/**
 * The frame's failed or signed-out `state` (`preview` when it shows a
 * draft), with Try again (`onRetry`), and Fix with Grasp (`onFix`) when
 * given and the draft caused it.
 */
export const FrameFailure = ({
  state,
  preview,
  onRetry,
  onFix,
}: {
  state: Extract<PageState, { status: "failed" | "signed-out" }>;
  preview: boolean;
  onRetry: () => void;
  onFix?: (() => void) | undefined;
}) => {
  const { i18n, t } = useLingui();
  if (state.status === "signed-out") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia icon={LogOutIcon} />
          <EmptyTitle level={2}>
            <Trans>Your session has ended</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>Sign in again to go on.</Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const { reason, detail } = state;
  const fixes = onFix !== undefined && fromTheDraft(reason);
  const details = detail === undefined ? reason : `${reason}\n${detail}`;
  return (
    <Empty variant="destructive">
      <EmptyHeader>
        <EmptyMedia illustration="broken" />
        <EmptyTitle level={2}>
          {preview && previewStarts.has(reason)
            ? t`The preview didn't start`
            : i18n._(titles[reason])}
        </EmptyTitle>
        <EmptyDescription>
          {preview && reason === "broken"
            ? t`The draft's code doesn't build.`
            : i18n._(reasons[reason])}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div {...stylex.props(styles.actions)}>
          <Button onClick={onRetry} variant="outline">
            <Icon icon={RefreshCwIcon} />
            {t`Try again`}
          </Button>
          {fixes ? (
            <Button onClick={onFix} variant="ghost">
              <Icon icon={SparklesIcon} />
              {t`Fix with Grasp`}
            </Button>
          ) : null}
        </div>
        <div {...stylex.props(styles.fold)}>
          <Collapsible>
            <CollapsibleTrigger>{t`Technical details`}</CollapsibleTrigger>
            <CollapsibleContent>
              <CodeBlock>
                <CodeBlockHeader>
                  <CodeBlockTitle />
                  <CodeBlockActions>
                    <CodeBlockCopyButton value={details} />
                  </CodeBlockActions>
                </CodeBlockHeader>
                <CodeBlockContent wrap>{details}</CodeBlockContent>
              </CodeBlock>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </EmptyContent>
    </Empty>
  );
};
