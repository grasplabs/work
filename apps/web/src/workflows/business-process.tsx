import { businessProcesses } from "@grasp-os/shared/business-processes";
import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The business process a workflow serves (GRA-511), as the prototype draws
// it (`components/process-icon.tsx`): an icon of its own and its standard
// name, with what it covers when pointed at. Core keeps the ID alone
// (`@grasp-os/shared/business-processes`); the words are the web's, in each
// language. An App's workflows serve their App's process; an independent
// workflow's is set by its builders (`workflowResources.setProcess`). It
// grants nothing: it only groups and marks.

/** Each process by its standard name. */
export const processNames: Readonly<
  Record<BusinessProcess, MessageDescriptor>
> = {
  o2c: msg({ message: "Opportunity-to-Cash", context: "business process" }),
  i2r: msg({ message: "Issue-to-Resolution", context: "business process" }),
  p2p: msg({ message: "Purchase-to-Pay", context: "business process" }),
  r2c: msg({ message: "Risk-to-Compliance", context: "business process" }),
  r2r: msg({ message: "Record-to-Report", context: "business process" }),
  h2r: msg({ message: "Hire-to-Retire", context: "business process" }),
};

/** What each process covers, for someone who never heard its name. */
export const processCovers: Readonly<
  Record<BusinessProcess, MessageDescriptor>
> = {
  o2c: msg`Everything from a first client conversation until the money is in the bank.`,
  i2r: msg`Every client question or complaint, from the first message until it is solved.`,
  p2p: msg`Everything from ordering from a supplier until their invoice is paid.`,
  r2c: msg`The checks, reviews and records the regulator expects from you.`,
  r2r: msg`Closing the books and producing the numbers leadership looks at.`,
  h2r: msg`Everything around employees, from hiring to leaving.`,
};

/**
 * Each process's parts, on Lucide's grid of 24: where the process ends
 * (cash in the till, a paid receipt, a solved message, a checked shield,
 * a report's bars, a person who comes and goes). Their parts move as
 * `icon-moves.css` says, by their order here: keep the two together.
 */
const Paths = ({ process }: { process: BusinessProcess }) => {
  switch (process) {
    case "o2c": {
      return (
        <>
          <circle cx="12" cy="7" r="4" />
          <path d="M3 13v4a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-4" />
        </>
      );
    }
    case "p2p": {
      return (
        <>
          <path d="M5 3h14v18l-3.5-2-3.5 2-3.5-2L5 21z" />
          <path d="M9 8h6" />
          <path d="M9 12h6" />
        </>
      );
    }
    case "i2r": {
      return (
        <>
          <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="m8.5 10 2.5 2.5L15.5 8" />
        </>
      );
    }
    case "r2c": {
      return (
        <>
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <path d="m9 12 2 2 4-4" />
        </>
      );
    }
    case "r2r": {
      return (
        <>
          <path d="M3 21h18" />
          <path d="M7 17v-4" />
          <path d="M12 17V9" />
          <path d="M17 17V4" />
        </>
      );
    }
    case "h2r": {
      return (
        <>
          <circle cx="9" cy="7" r="4" />
          <path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2" />
          <path d="M16 8h6" />
          <path d="m19.5 5.5 2.5 2.5-2.5 2.5" />
        </>
      );
    }
    default: {
      return null;
    }
  }
};

/** A process's icon alone, sized like a Lucide icon: for lines, menus and badges. */
export const ProcessGlyph = ({
  process,
  className = "size-4 flex-none",
}: {
  process: BusinessProcess;
  className?: string;
}) => (
  <svg
    aria-hidden="true"
    className={className}
    data-moves={process}
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <Paths process={process} />
  </svg>
);

/** A process's icon on a grey tile, where a line begins, as an engine's is. */
export const ProcessTile = ({ process }: { process: BusinessProcess }) => (
  <span
    aria-hidden="true"
    className="bg-muted text-foreground inline-flex size-7.5 flex-none items-center justify-center rounded-lg"
  >
    <ProcessGlyph process={process} />
  </span>
);

/** Its name over what it covers: what a process says when pointed at. */
export const ProcessHint = ({ process }: { process: BusinessProcess }) => {
  const { i18n } = useLingui();
  return (
    <span className="flex flex-col gap-1 py-0.5">
      <span className="font-medium">{i18n._(processNames[process])}</span>
      <span>{i18n._(processCovers[process])}</span>
    </span>
  );
};

/** A process as a badge, its icon and name, with what it covers when pointed at. */
export const ProcessBadge = ({ process }: { process: BusinessProcess }) => {
  const { i18n } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" />}>
        <ProcessGlyph className="size-3 flex-none" process={process} />
        {i18n._(processNames[process])}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        <ProcessHint process={process} />
      </TooltipContent>
    </Tooltip>
  );
};

/** The value the picker gives for no process. */
const none = "none";

/**
 * The process an independent workflow serves, as its builders set it: one
 * of the fixed list, or none. Core checks they may, and audits it.
 */
export const ProcessPicker = ({
  workflow,
  name,
  process,
  onChange,
}: {
  workflow: string;
  name: string;
  process: BusinessProcess | null;
  onChange: () => void;
}) => {
  const { t, i18n } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const items = [
    { value: none, label: t`No business process` },
    ...businessProcesses.map((each) => ({
      value: each,
      label: i18n._(processNames[each]),
    })),
  ];
  const set = async (chosen: BusinessProcess | null): Promise<void> => {
    const changed = await run(
      async (session) =>
        await session.workflowResources.setProcess(workflow, chosen)
    );
    if (changed !== undefined) {
      onChange();
    }
  };
  return (
    <span className="flex flex-col gap-1">
      <Select
        disabled={busy}
        items={items}
        onValueChange={(value: string | null) => {
          const chosen =
            businessProcesses.find((each) => each === value) ?? null;
          if (chosen !== process) {
            void set(chosen);
          }
        }}
        value={process ?? none}
      >
        <SelectTrigger
          aria-label={t`The business process ${name} serves`}
          size="sm"
        >
          {process === null ? null : <ProcessGlyph process={process} />}
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ErrorText>{failure}</ErrorText>
    </span>
  );
};
