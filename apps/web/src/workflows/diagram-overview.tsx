import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import type { DiagramPart } from "./diagram-parts.ts";

// A workflow in named parts, as a page to take in and then to read
// (prototype `inside-overview.tsx`). Shut, it is a line a part: its
// number, its name, what it is for in one sentence, and how many steps it
// holds. Opened, a part tells itself in a few sentences (its summary,
// which Grasp writes when it drafts) and who comes in, with the way to its
// place in the drawing. Every part opens and shuts by itself, and all of
// them at once from the top.

/** Who comes in to a part, in words: how many of its steps ask a person. */
const useComesIn = (decisions: number): string => {
  const { t } = useLingui();
  return decisions === 0
    ? t`Nobody comes in: Grasp does all of it.`
    : t`${plural(decisions, {
        one: "A person comes in at one step, to decide.",
        other: "People come in at # steps, to decide.",
      })}`;
};

const OverviewPart = ({
  part,
  open,
  onToggle,
  onShow,
}: {
  part: DiagramPart;
  open: boolean;
  onToggle: () => void;
  onShow: () => void;
}) => {
  const { t } = useLingui();
  const comesIn = useComesIn(part.decisions);
  const { n, steps } = part;
  const name = part.name === "" ? t`Before the first part` : part.name;
  const body = `overview-part-${n}`;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 border-b py-3.5 @3xl:grid-cols-[14.5rem_minmax(0,1fr)_9rem]">
      <h2 className="min-w-0">
        <button
          aria-controls={body}
          aria-expanded={open}
          className="focus-visible:ring-ring/50 flex w-full items-baseline gap-3 rounded-md text-left outline-none focus-visible:ring-3"
          onClick={onToggle}
          type="button"
        >
          <span className="text-muted-foreground w-6 flex-none tabular-nums">
            {n}
          </span>
          <span className="min-w-0 font-medium text-pretty">{name}</span>
        </button>
      </h2>
      <div
        className="order-3 col-span-full pl-9 @3xl:order-none @3xl:col-span-1 @3xl:pl-0"
        id={body}
      >
        {open ? (
          <div className="animate-in fade-in flex max-w-prose flex-col gap-3 leading-relaxed duration-300">
            <p className="text-pretty">
              {part.summary ?? part.purpose ?? comesIn}
            </p>
            <p className="text-muted-foreground text-pretty">{comesIn}</p>
          </div>
        ) : (
          <p className="text-muted-foreground leading-relaxed text-pretty">
            {part.purpose}
          </p>
        )}
      </div>
      <div className="order-2 flex flex-col items-end gap-3 @3xl:order-none">
        <span className="text-muted-foreground flex items-center gap-3">
          <span className="tabular-nums">
            {t`${plural(steps, { one: "# step", other: "# steps" })}`}
          </span>
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-4 flex-none transition-transform duration-300",
              open && "rotate-90"
            )}
          />
        </span>
        {open ? (
          <Button
            aria-label={t`Show ${name} in the drawing`}
            onClick={onShow}
            size="sm"
            variant="outline"
          >
            <Trans>Show in the drawing</Trans>
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        ) : null}
      </div>
    </li>
  );
};

/** Every part of a workflow drawn in parts, one line each; `onShow` goes to a part's frame. */
export const DiagramOverview = ({
  parts,
  onShow,
}: {
  parts: readonly DiagramPart[];
  onShow: (part: DiagramPart) => void;
}) => {
  const { t } = useLingui();
  // The first part is open, to show what an open part holds.
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set([1]));
  const all = open.size === parts.length;
  const many = parts.length;
  return (
    <article className="@container flex w-full flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <p className="text-muted-foreground max-w-2xl text-base leading-relaxed text-pretty">
          {t`${plural(many, {
            one: "The work is one part.",
            other: "The work goes through # parts, one after another.",
          })}`}
        </p>
        <Button
          className="flex-none"
          onClick={() => {
            setOpen(all ? new Set() : new Set(parts.map(({ n }) => n)));
          }}
          size="sm"
          variant="outline"
        >
          {all ? (
            <Trans context="shut every part of a workflow's overview">
              Close all
            </Trans>
          ) : (
            <Trans context="open every part of a workflow's overview">
              Open all
            </Trans>
          )}
        </Button>
      </header>
      <ol className="flex flex-col border-t">
        {parts.map((part) => (
          <OverviewPart
            key={part.n}
            onShow={() => {
              onShow(part);
            }}
            onToggle={() => {
              const next = new Set(open);
              if (!next.delete(part.n)) {
                next.add(part.n);
              }
              setOpen(next);
            }}
            open={open.has(part.n)}
            part={part}
          />
        ))}
      </ol>
    </article>
  );
};
