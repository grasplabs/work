/**
 * The parts an organization's Setup (src/admin/setup.tsx) is laid out
 * with, shared with what staff do there (src/admin/setup-actions.tsx): a
 * quiet line, facts as rows, and an error's code; its sections are
 * the admin's (src/admin/section.tsx).
 */
import { cn } from "@grasp-os/ui/lib/utils";
import type { ReactNode } from "react";

/** An error code as the section says it: the code alone, as the admin keeps it. */
export const ErrorCode = ({ code }: { code: string }) => (
  <span className="font-mono text-xs">{code}</span>
);

/** A line in a section, for what it has none of yet. */
export const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground border-t px-5 py-3">{children}</p>
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
