/**
 * The parts an organization's Setup (src/admin/setup.tsx) is laid out
 * with, shared with what staff do there (src/admin/setup-actions.tsx): a
 * titled section, a quiet line, facts as rows, and an error's code.
 */
import { cn } from "@grasp-os/ui/lib/utils";
import type { ReactNode } from "react";

/** An error code as the section says it: the code alone, as the admin keeps it. */
export const ErrorCode = ({ code }: { code: string }) => (
  <span className="font-mono text-xs">{code}</span>
);

/** A titled part of the section, with what can be done beside its title. */
export const SetupSection = ({
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
  <section
    aria-label={title}
    className="bg-card overflow-hidden rounded-xl border text-sm"
  >
    {/* Where there is no room beside it, what can be done goes under the title. */}
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-5 py-4">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
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

/** A line in a section, for what it has none of yet. */
export const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground border-t px-5 py-3">{children}</p>
);

/** A part of a section below its title: what staff fill in or do there. */
export const Body = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col gap-4 border-t px-5 py-4">{children}</div>
);

/** A few facts as rows: what it is on the left, the fact on the right. */
export const Facts = ({
  rows,
}: {
  rows: { label: string; value: ReactNode; attention?: boolean }[];
}) => (
  <dl className="flex flex-col">
    {rows.map((row) => (
      <div
        className="flex items-baseline justify-between gap-4 border-t px-5 py-3"
        key={row.label}
      >
        <dt className="text-muted-foreground flex-none">{row.label}</dt>
        <dd
          className={cn(
            "min-w-0 text-right wrap-break-word",
            row.attention === true && "text-status-attention"
          )}
        >
          {row.value}
        </dd>
      </div>
    ))}
  </dl>
);

/** Why the last thing staff did failed, until the next; nothing when it didn't. */
export const Failure = ({ failure }: { failure: string | null }) =>
  failure === null ? null : (
    <p className="text-destructive text-sm" role="alert">
      {failure}
    </p>
  );

/** A ring as the admin says it: the first one by name. */
export const ringWords = (ring: number): string =>
  ring === 0 ? "Ring 0, first" : `Ring ${ring}`;
