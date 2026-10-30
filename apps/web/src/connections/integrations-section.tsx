import type { ReactNode } from "react";

import { formatNumber } from "../format.ts";

// One list on the Integrations page, as the prototype draws it
// (`routes/integrations/index.tsx`, `Section`): its name, how many apps it
// holds and a line about them, over the apps in two columns where the page
// has room.

/** A list of apps under its name and count; nothing at all when it is empty. */
export const IntegrationsSection = ({
  id,
  title,
  count,
  about,
  children,
}: {
  /** Names the heading the list is labelled by. */
  id: string;
  title: string;
  count: number;
  about?: string;
  children: ReactNode;
}) => {
  if (count === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby={`integrations-${id}`}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          className="flex items-baseline gap-2 font-medium"
          id={`integrations-${id}`}
        >
          {title}
          <span className="text-muted-foreground text-xs font-normal tabular-nums">
            {formatNumber(count)}
          </span>
        </h2>
        {about === undefined ? null : (
          <p className="text-muted-foreground">{about}</p>
        )}
      </div>
      <ul className="grid grid-cols-1 gap-x-10 gap-y-1 @2xl:grid-cols-2">
        {children}
      </ul>
    </section>
  );
};
