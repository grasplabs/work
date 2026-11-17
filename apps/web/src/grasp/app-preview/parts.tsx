// App preview's parts: the width choices, the reload and open controls, and the layers that stand
// over the frame while the app is not running (loading, failed, asleep).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import { Button } from "../button";
import type { ActionState } from "../button";
import { Collapsible } from "../collapsible";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Desktop,
  Expand,
  External,
  Fit,
  More as MoreIcon,
  Phone,
  Play,
  Retry,
  Tablet,
} from "../icons";
import { Spinner } from "../spinner";
import { Toggle, ToggleGroup } from "../toggle";
import type {
  AppPreviewFailure,
  AppPreviewLabels,
  AppPreviewStopped,
  AppPreviewWidth,
} from "./labels";
import { styles } from "./styles";

const widths: readonly AppPreviewWidth[] = [
  "phone",
  "tablet",
  "desktop",
  "fit",
];
const widthIcons = {
  phone: Phone,
  tablet: Tablet,
  desktop: Desktop,
  fit: Fit,
} as const;

const isWidth = (value: string | undefined): value is AppPreviewWidth =>
  widths.some((width) => width === value);

interface ControlsProps {
  labels: AppPreviewLabels;
  width: AppPreviewWidth;
  onWidth: (width: AppPreviewWidth) => void;
  onReload: () => void;
  src: string;
  /** Whether the reload button can be pressed: only while there is an app in the frame. */
  canReload: boolean;
}

/** The width choices: one tab stop, the arrow keys between them, each named. */
export const Widths = ({
  labels,
  width,
  onWidth,
}: Pick<ControlsProps, "labels" | "width" | "onWidth">) => (
  <ToggleGroup
    aria-label={labels.widths}
    size="md"
    value={[width]}
    onValueChange={(next) => {
      const [chosen] = next;
      // Pressing the pressed one again would leave none: the width stays.
      if (isWidth(chosen)) {
        onWidth(chosen);
      }
    }}
  >
    {widths.map((each) => (
      <Toggle
        key={each}
        value={each}
        icon={widthIcons[each]}
        aria-label={labels[each]}
      />
    ))}
  </ToggleGroup>
);

/** Reload, copy link, full screen and open in a new tab; all but reload fold into More when narrow. */
interface ActionsProps extends Pick<
  ControlsProps,
  "labels" | "onReload" | "src" | "canReload"
> {
  full: boolean;
  onFullscreen: () => void;
  onCopy: () => void;
  /** Where the copy is: its button shows the tick, or the failed mark, for duration-hold. */
  copied: ActionState;
}

export const Actions = ({
  labels,
  onReload,
  src,
  canReload,
  full,
  onFullscreen,
  onCopy,
  copied,
}: ActionsProps) => (
  <span {...stylex.props(styles.actions)}>
    <Button
      variant="ghost"
      size="xs"
      icon={Retry}
      aria-label={labels.reload}
      disabled={!canReload}
      focusableWhenDisabled
      onClick={onReload}
    />
    <span {...stylex.props(styles.actions, styles.folds)}>
      {/* The words are said once, by the status line (a live region): the button only shows the mark. */}
      <Button
        variant="ghost"
        size="xs"
        icon={Copy}
        aria-label={labels.copy}
        onClick={onCopy}
        status={copied}
        doneLabel=""
        failedLabel=""
      />
      <Button
        variant="ghost"
        size="xs"
        icon={Expand}
        aria-label={full ? labels.leaveFullscreen : labels.fullscreen}
        aria-pressed={full}
        onClick={onFullscreen}
      />
      <Button
        variant="ghost"
        size="xs"
        icon={External}
        aria-label={labels.open}
        render={
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={labels.open}
          />
        }
      />
    </span>
  </span>
);

interface MoreProps extends Pick<
  ControlsProps,
  "labels" | "width" | "onWidth" | "src"
> {
  full: boolean;
  onFullscreen: () => void;
  onCopy: () => void;
}

/** In a narrow room, what folded: the widths as one choice, then copy, full screen and open, in words
 * only, so every item starts on one edge. */
export const More = ({
  labels,
  width,
  onWidth,
  src,
  full,
  onFullscreen,
  onCopy,
}: MoreProps) => (
  <span {...stylex.props(styles.more)} data-slot="app-preview-more">
    <DropdownMenu>
      <DropdownMenuTrigger
        variant="ghost"
        size="xs"
        icon={MoreIcon}
        aria-label={labels.more}
      />
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={width}
          onValueChange={(next: unknown) => {
            if (typeof next === "string" && isWidth(next)) {
              onWidth(next);
            }
          }}
        >
          <DropdownMenuLabel>{labels.widths}</DropdownMenuLabel>
          {widths.map((each) => (
            <DropdownMenuRadioItem key={each} value={each}>
              {labels[each]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCopy}>{labels.copy}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onFullscreen}>
          {full ? labels.leaveFullscreen : labels.fullscreen}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            window.open(
              new URL(src, window.location.href).href,
              "_blank",
              "noopener,noreferrer"
            );
          }}
        >
          {labels.open}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </span>
);

/** A new version on its way: the last one stays, dimmed a little, with a quiet line at its foot. */
export const Updating = ({ label }: { label: string }) => (
  <div {...stylex.props(styles.updating)} data-slot="app-preview-updating">
    <span {...stylex.props(styles.updatingLine)}>
      <span aria-hidden="true">
        <Spinner aria-label={label} size="sm" />
      </span>
      {label}
    </span>
  </div>
);

/** A quiet loading layer: the frame stands under it, hidden and inert, until the app is up. */
export const Loading = ({ label }: { label: string }) => (
  <div {...stylex.props(styles.layer)} data-slot="app-preview-loading">
    <Spinner aria-label={label} />
  </div>
);

/** The app's own way about: back and forward, each shown only when the product can answer it. */
export const History = ({
  labels,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
}: {
  labels: AppPreviewLabels;
  onBack: (() => void) | undefined;
  onForward: (() => void) | undefined;
  canGoBack: boolean;
  canGoForward: boolean;
}) =>
  onBack === undefined && onForward === undefined ? null : (
    <span {...stylex.props(styles.actions)}>
      {onBack === undefined ? null : (
        <Button
          variant="ghost"
          size="xs"
          icon={ChevronLeft}
          aria-label={labels.back}
          disabled={!canGoBack}
          focusableWhenDisabled
          onClick={onBack}
        />
      )}
      {onForward === undefined ? null : (
        <Button
          variant="ghost"
          size="xs"
          icon={ChevronRight}
          aria-label={labels.forward}
          disabled={!canGoForward}
          focusableWhenDisabled
          onClick={onForward}
        />
      )}
    </span>
  );

/** A layer that takes the focus as it appears after another state: the failure. */
const useFocusOnArrival = (arrived: boolean) => {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (arrived) {
      heading.current?.focus();
    }
  }, [arrived]);
  return heading;
};

interface FailedProps {
  failure: AppPreviewFailure;
  labels: AppPreviewLabels;
  onRetry: (() => void) | undefined;
  onFix: (() => void) | undefined;
  /** It came after another state, not with the page: the focus moves to it. */
  arrived: boolean;
}

/** What failed, said at once (an alert), the focus on its title, Fix first, Retry, then the details. */
export const Failed = ({
  failure,
  labels,
  onRetry,
  onFix,
  arrived,
}: FailedProps) => {
  const heading = useFocusOnArrival(arrived);
  const details = failure.details ?? "";
  const description = failure.description ?? "";
  return (
    <div
      {...stylex.props(styles.layer)}
      role="alert"
      data-slot="app-preview-failed"
    >
      <h2 ref={heading} tabIndex={-1} {...stylex.props(styles.heading)}>
        {failure.title}
      </h2>
      {description === "" ? null : (
        <p {...stylex.props(styles.sentence)}>{description}</p>
      )}
      {onFix !== undefined && failure.fix !== undefined ? (
        // The agent can fix it: that is the first thing to do, Retry beside it.
        <span {...stylex.props(styles.choices)}>
          <Button variant="ink" onClick={onFix}>
            {failure.fix}
          </Button>
          <Button variant="quiet" icon={Retry} onClick={onRetry}>
            {failure.retry}
          </Button>
        </span>
      ) : (
        <Button variant="ink" icon={Retry} onClick={onRetry}>
          {failure.retry}
        </Button>
      )}
      {details === "" ? null : (
        <div {...stylex.props(styles.details)}>
          <Collapsible title={labels.details}>
            <pre {...stylex.props(styles.code)}>{details}</pre>
          </Collapsible>
        </div>
      )}
    </div>
  );
};

/** The app is asleep: what is the case, and the action that wakes it. */
export const Stopped = ({
  stopped,
  onStart,
}: {
  stopped: AppPreviewStopped;
  onStart: (() => void) | undefined;
}) => {
  const description = stopped.description ?? "";
  return (
    <div {...stylex.props(styles.layer)} data-slot="app-preview-stopped">
      <h2 {...stylex.props(styles.heading)}>{stopped.title}</h2>
      {description === "" ? null : (
        <p {...stylex.props(styles.sentence)}>{description}</p>
      )}
      <Button variant="ink" icon={Play} onClick={onStart}>
        {stopped.start}
      </Button>
    </div>
  );
};
