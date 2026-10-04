import { useLingui } from "@lingui/react/macro";
import { useId } from "react";
import type { ReactNode } from "react";

import { LoadingLines } from "../frame/page-states.tsx";

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
    <section
      aria-labelledby={id}
      className="bg-card overflow-hidden rounded-xl border text-sm"
    >
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-medium" id={id}>
            {title}
          </h2>
          {description === undefined ? null : (
            <div className="text-muted-foreground">{description}</div>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
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
  <div className="flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
    <div className="flex min-w-0 flex-col gap-0.5">
      {htmlFor === undefined ? (
        <span>{label}</span>
      ) : (
        <label htmlFor={htmlFor}>{label}</label>
      )}
      {description === undefined ? null : (
        <p className="text-muted-foreground">{description}</p>
      )}
    </div>
    <div className="flex flex-none sm:w-64 sm:justify-end">{children}</div>
  </div>
);

/** What fills a section's card below its heading: rows' worth of room. */
export const SettingsBody = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col gap-4 border-t px-5 py-4">{children}</div>
);

/** A section while its read is slow: its card, with lines where its rows will be. */
export const SettingsLoading = () => {
  const { t } = useLingui();
  return (
    <SettingsSection title={t`Loading…`}>
      <SettingsBody>
        <LoadingLines lines={4} />
      </SettingsBody>
    </SettingsSection>
  );
};
