import { Button } from "@grasp-os/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { useWide } from "../frame/wide.ts";
import { useAppPanel } from "./app-panel-context.tsx";
import type { AppPanel, OpenedPanel } from "./app-panel-context.tsx";
import { ScreenFrame } from "./screen-frame.tsx";
import type { FailureReason } from "./screen-host.ts";
import { usePushNavigate } from "./screen-navigate.ts";

// The shell's panel slot (spec 34.1, decision 3 on the surfaces split):
// one App screen at a time beside every page, a sheet over it on a narrow
// window, opened from the chat's side panel or by a screen's navigation to
// a panel surface. It sits outside the page, so the page navigating under
// it, a screen in it opening a route in the main pane among them, leaves
// it open. Opening another replaces it; closing it takes its frame down,
// which lets go of the frame's port, subscriptions and streams. Work the
// screen started that core admitted carries on as it does when any frame
// goes.

/** Why a panel's screen ended that close the panel: its App is gone for them. */
const closesPanel: ReadonlySet<FailureReason> = new Set<FailureReason>([
  "not-found",
  "forbidden",
  "principal-changed",
]);

/** The panel's screen, with its chrome: its title and a way to close it. */
const PanelScreen = ({
  opened,
  onClose,
  onDiscard,
  onGuard,
}: {
  opened: OpenedPanel;
  /** Closes it, asking first while its screen holds edits. */
  onClose: () => void;
  /** Closes it without asking: its App is gone for the person. */
  onDiscard: () => void;
  onGuard: (guarded: boolean) => void;
}) => {
  const { t } = useLingui();
  // A screen in the panel opens a route in the main pane, as a new entry:
  // the panel stays (decision 4 on the navigation split).
  const navigate = usePushNavigate(opened.app);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {opened.title}
        </h2>
        <Link
          className="text-sm underline"
          params={{ engine: opened.app }}
          to="/domains/$engine"
        >
          <Trans>Workflows and more</Trans>
        </Link>
        <Button
          aria-label={t`Close panel`}
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      <ScreenFrame
        app={opened.app}
        beside
        embedded
        onEnded={(ended) => {
          // The App is gone for the person, or they are: the panel goes too.
          if (ended.status === "signed-out" || closesPanel.has(ended.reason)) {
            onDiscard();
          }
        }}
        onGuardChange={onGuard}
        onNavigate={navigate}
        screen={opened.screen}
        {...(opened.route === undefined ? {} : { route: opened.route })}
        {...(opened.input === undefined ? {} : { input: opened.input })}
        {...(opened.surface === undefined ? {} : { surface: opened.surface })}
      />
    </div>
  );
};

/** What tells one opening of the panel from another: a fresh start. */
const openingKey = (opened: OpenedPanel): string =>
  `${opened.app}/${opened.screen}/${opened.route ?? ""}/${opened.input ?? ""}/${opened.surface ?? ""}`;

/**
 * One opening of the panel, beside the page on a wide window, a sheet
 * otherwise. Changing between them starts its frame again, so while its
 * screen holds edits it stays where it is, however the window changes,
 * and follows the window once they are gone.
 */
const PlacedPanel = ({
  panel,
}: {
  panel: AppPanel & { opened: OpenedPanel };
}) => {
  const { opened, close, discard, guarded } = panel;
  const wide = useWide();
  const { t } = useLingui();
  const [held, setHeld] = useState(false);
  const [beside, setBeside] = useState(wide);
  if (beside !== wide && !held) {
    setBeside(wide);
  }
  const screen = (
    <PanelScreen
      onClose={close}
      onDiscard={discard}
      onGuard={(holds) => {
        guarded(holds);
        setHeld(holds);
      }}
      opened={opened}
    />
  );
  if (beside) {
    return (
      <aside
        aria-label={t`Side panel`}
        className="bg-background flex w-96 flex-none flex-col overflow-y-auto border-l p-4"
      >
        {screen}
      </aside>
    );
  }
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
    >
      <SheetContent closeLabel={t`Close`} side="right">
        <SheetTitle className="sr-only">
          <Trans>Side panel</Trans>
        </SheetTitle>
        <div className="flex flex-1 flex-col overflow-y-auto p-4">{screen}</div>
      </SheetContent>
    </Sheet>
  );
};

/** The slot itself: the panel's opening, when it shows one. */
export const AppPanelSlot = () => {
  const panel = useAppPanel();
  const opened = panel?.opened ?? null;
  if (panel === null || opened === null) {
    return null;
  }
  return <PlacedPanel key={openingKey(opened)} panel={{ ...panel, opened }} />;
};
