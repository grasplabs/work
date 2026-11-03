/**
 * The rows Platform's pages draw in their panels, as the organization's
 * Setup draws its own (src/admin/setup.tsx): facts as rows, and a quiet
 * line when there is nothing.
 */
import { cn } from "@grasp-os/ui/lib/utils";
import type { ReactNode } from "react";

/** A line in a panel saying there is nothing to show. */
export const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground border-t px-5 py-3">{children}</p>
);

/** One fact: what it is, and the fact, in type when it is an id or a hash. */
export interface Fact {
  label: string;
  value: ReactNode;
  mono?: boolean;
  attention?: boolean;
}

/** A few facts as rows: what it is on the left, the fact on the right. */
export const Facts = ({ rows }: { rows: readonly Fact[] }) => (
  <dl className="flex flex-col">
    {rows.map((row) => (
      <div
        className="flex items-baseline justify-between gap-4 border-t px-5 py-3"
        key={row.label}
      >
        <dt className="text-muted-foreground flex-none">{row.label}</dt>
        <dd
          className={cn(
            "min-w-0 text-right break-all",
            row.mono === true && "font-mono text-xs",
            row.attention === true && "text-status-attention"
          )}
        >
          {row.value}
        </dd>
      </div>
    ))}
  </dl>
);

/** A list, in words: `none` when it's empty. */
export const listed = (items: readonly string[]): string =>
  items.join(", ") || "none";
