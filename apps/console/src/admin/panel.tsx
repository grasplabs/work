/**
 * One part of a section, as the prototype draws it (grasplabs/prototype
 * `components/settings.tsx`, `SettingsSection`): a card with its title,
 * a line on what it holds, maybe an action beside them, and its rows
 * under a line each.
 */
import type { ReactNode } from "react";

export const Panel = ({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="bg-card overflow-hidden rounded-xl border">
    <div className="flex items-start justify-between gap-4 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="font-medium">{title}</h2>
        {description === undefined ? null : (
          <p className="text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
    {children}
  </section>
);
