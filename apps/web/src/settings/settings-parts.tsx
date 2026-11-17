import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardRow,
  CardRowControl,
  CardRowLabel,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { cn } from "@grasp-os/ui/lib/utils";
import { useId } from "react";
import type { ReactNode } from "react";

// Settings' building blocks, as in the prototype (`components/settings.tsx`):
// a section on a card of its own, and its rows.

/** A group of settings on one card: a title, one line on what it is for, then its rows. */
export const SettingsSection = ({
  title,
  description,
  media,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** A picture before the title, such as Stephen's head: the title then stands in line with it. */
  media?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) => {
  // Named by its title, so it is a region of the page.
  const id = useId();
  return (
    <Card aria-labelledby={id} render={<section />} variant="panel">
      <CardHeader>
        <CardTitle>
          {media === undefined ? (
            <h2 id={id}>{title}</h2>
          ) : (
            <span className="flex items-center gap-3">
              {media}
              <h2 id={id}>{title}</h2>
            </span>
          )}
        </CardTitle>
        {description === undefined ? null : (
          <CardDescription>{description}</CardDescription>
        )}
        {action === undefined ? null : (
          // Beside a picture and no description, in line with the title, as in the prototype's Stephen card.
          <CardAction
            className={cn(
              media !== undefined && description === undefined && "self-center"
            )}
          >
            {action}
          </CardAction>
        )}
      </CardHeader>
      {children}
    </Card>
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
  <CardRow>
    <CardRowLabel>
      {htmlFor === undefined ? (
        <span>{label}</span>
      ) : (
        <label htmlFor={htmlFor}>{label}</label>
      )}
      {description === undefined ? null : (
        <p className="text-muted-foreground">{description}</p>
      )}
    </CardRowLabel>
    <CardRowControl>{children}</CardRowControl>
  </CardRow>
);

/** What fills a section's card below its heading: rows' worth of room. */
export const SettingsBody = ({ children }: { children: ReactNode }) => (
  <CardContent>{children}</CardContent>
);
