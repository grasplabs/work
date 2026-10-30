import {
  Panel,
  PanelBody,
  PanelDescription,
  PanelHeader,
  PanelHeading,
  PanelRow,
  PanelRowControl,
  PanelRowLabel,
  PanelTitle,
} from "@grasp-os/ui/components/panel";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useId } from "react";
import type { ReactNode } from "react";

import { isFileGone } from "../error-reports.ts";
import { ErrorState, LoadingLines } from "../frame/page-states.tsx";
import { useRouteErrorReason } from "../route-error.tsx";

// Settings' building blocks, as in the prototype (`components/settings.tsx`):
// a section on a card of its own, and its rows.

/** A group of settings on one card: a title, one line on what it is for, then its rows. */
export const SettingsSection = ({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) => {
  // Named by its title, so it is a region of the page.
  const id = useId();
  return (
    <Panel aria-labelledby={id}>
      <PanelHeader>
        <PanelHeading>
          <PanelTitle id={id}>{title}</PanelTitle>
          {description === undefined ? null : (
            <PanelDescription>{description}</PanelDescription>
          )}
        </PanelHeading>
        {action}
      </PanelHeader>
      {children}
    </Panel>
  );
};

/** One setting: what it is and why on the left, its control on the right. */
export const SettingsRow = ({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  /** The control's id, so the label focuses it. */
  htmlFor?: string;
  children: ReactNode;
}) => (
  <PanelRow>
    <PanelRowLabel>
      {htmlFor === undefined ? (
        <span>{label}</span>
      ) : (
        <label htmlFor={htmlFor}>{label}</label>
      )}
      {description === undefined ? null : (
        <p className="text-muted-foreground">{description}</p>
      )}
    </PanelRowLabel>
    <PanelRowControl>{children}</PanelRowControl>
  </PanelRow>
);

/** What fills a section's card below its heading: rows' worth of room. */
export const SettingsBody = ({ children }: { children: ReactNode }) => (
  <PanelBody>{children}</PanelBody>
);

/** A section while its read is slow: its card, with skeletons where its title and rows will be. */
export const SettingsLoading = () => (
  <Panel>
    <div className="flex flex-col gap-2 px-5 py-4">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-4 w-72 max-w-full" />
    </div>
    <SettingsBody>
      <LoadingLines lines={4} />
    </SettingsBody>
  </Panel>
);

/**
 * A section that failed as it rendered: the error on its card, in the
 * Settings layout, rather than a page of its own with a second header.
 */
export const SettingsError = ({ error }: ErrorComponentProps) => (
  <Panel>
    <ErrorState
      heading="h2"
      reason={useRouteErrorReason(error)}
      reload={isFileGone(error)}
    />
  </Panel>
);
