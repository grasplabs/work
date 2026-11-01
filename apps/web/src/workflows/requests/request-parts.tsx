import type {
  RequestsPage,
  RequestTool,
} from "@grasp-os/shared/stephen-requests";
import { brainTool, elsewhere } from "@grasp-os/shared/stephen-requests";
import { Progress } from "@grasp-os/ui/components/progress";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import {
  BrainIcon,
  ChevronRightIcon,
  LayoutGridIcon,
  WorkflowIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { AppLogo } from "../../connections/app-logo.tsx";
import { formatPercent } from "../../format.ts";

// The parts every block of Workflows › Requests shares, as the prototype's
// `components/requests/request-parts.tsx`: names for what the report
// counts by id, marks for the tools and places, a row that opens what it
// is about, and what grew.

/** Chat platforms as people know them. */
const placeNames: Readonly<Record<string, string>> = {
  teams: "Microsoft Teams",
  slack: "Slack",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  gmail: "Gmail",
};

/**
 * Logos the deployment serves, by the platform or provider they are of
 * (`apps/web/public/logos`). Where each comes from:
 * - microsoft-teams.svg, slack.svg, whatsapp.svg and gmail.svg: the
 *   gilbarbara/logos set, through @iconify-json/logos, CC0, as the
 *   prototype bundles them.
 * - microsoft.svg and google.svg: the marks of Microsoft's and Google's own
 *   sign-in button guidelines, drawn as plain SVG.
 * The trademarks stay with their owners; they are shown only to name the
 * place or provider.
 */
const logos: Readonly<Record<string, string>> = {
  teams: "/logos/microsoft-teams.svg",
  slack: "/logos/slack.svg",
  whatsapp: "/logos/whatsapp.svg",
  microsoft: "/logos/microsoft.svg",
  gmail: "/logos/gmail.svg",
  google: "/logos/google.svg",
};

/** A place's name, as people know it. */
export const placeName = (place: string): string => placeNames[place] ?? place;

/** A place's logo, as a tile beside its name. */
export const PlaceLogo = ({
  place,
  size = "xs",
}: {
  place: string;
  size?: "xs" | "inline" | "sm" | "default";
}) => (
  <AppLogo logo={logos[place] ?? null} name={placeName(place)} size={size} />
);

/** The names the page gives what it counts, the folded groups named as such. */
export const useRequestNames = (
  page: Pick<RequestsPage, "topics" | "questions" | "teams" | "people">
) => {
  const { t } = useLingui();
  const topics = new Map(page.topics.map(({ id, name }) => [id, name]));
  const questions = new Map(page.questions.map((row) => [row.id, row]));
  const teams = new Map(page.teams.map(({ id, name }) => [id, name]));
  const people = new Map(page.people.map(({ id, name }) => [id, name]));
  return {
    topic: (id: string | null): string => {
      if (id === elsewhere) {
        return t`Other topics`;
      }
      return id === null ? t`Not sorted yet` : (topics.get(id) ?? t`A topic`);
    },
    question: (id: string): string => questions.get(id)?.name ?? t`A question`,
    role: (id: string): string | null => questions.get(id)?.role ?? null,
    team: (id: string): string => {
      if (id === elsewhere) {
        return t`Other teams`;
      }
      return teams.get(id) ?? t`A team`;
    },
    person: (id: string): string => people.get(id) ?? t`Someone`,
    tool: (tool: RequestTool): string => {
      if (tool === brainTool) {
        return t`The brain`;
      }
      if (tool === elsewhere) {
        return t`Other tools`;
      }
      if (tool.startsWith("workflow:")) {
        return t`A workflow`;
      }
      if (tool.startsWith("app:")) {
        return t`An App`;
      }
      const [app = tool, ...action] = tool.split(".");
      return action.length === 0 ? app : `${app} · ${action.join(".")}`;
    },
  };
};

/** A mark for what has no logo, the size of an app's in a row. */
export const IconMark = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <span
    className="bg-tile text-muted-foreground inline-flex size-5 flex-none items-center justify-center rounded-md border [&_svg]:size-3"
    title={label}
  >
    {children}
    <span className="sr-only">{label}</span>
  </span>
);

/** A tool's mark: the brain, a workflow, an App, or the logo of the app an action is in. */
export const ToolMark = ({
  tool,
  label,
}: {
  tool: RequestTool;
  label: string;
}) => {
  if (tool === brainTool) {
    return (
      <IconMark label={label}>
        <BrainIcon />
      </IconMark>
    );
  }
  if (tool.startsWith("workflow:")) {
    return (
      <IconMark label={label}>
        <WorkflowIcon />
      </IconMark>
    );
  }
  if (tool.startsWith("app:") || tool === elsewhere) {
    return (
      <IconMark label={label}>
        <LayoutGridIcon />
      </IconMark>
    );
  }
  const [app = tool] = tool.split(".");
  return <AppLogo logo={logos[app] ?? null} name={label} size="inline" />;
};

/**
 * One row of a list on the page: the whole row opens what it is about,
 * with a chevron at its end; a row about a folded group opens nothing and
 * keeps the chevron's room. `className` lays out the row's cells, the
 * chevron's column last.
 */
export const OpenRow = ({
  className,
  onOpen,
  children,
}: {
  className: string;
  onOpen?: (() => void) | undefined;
  children: ReactNode;
}) => {
  const chevron = (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        "text-muted-foreground size-4 flex-none justify-self-end",
        onOpen === undefined && "invisible"
      )}
    />
  );
  if (onOpen === undefined) {
    return (
      <li className={cn("border-t", className)}>
        {children}
        {chevron}
      </li>
    );
  }
  return (
    <li className="border-t">
      <button
        className={cn(
          "hover:bg-accent focus-visible:bg-accent w-full text-left outline-none",
          className
        )}
        onClick={onOpen}
        type="button"
      >
        {children}
        {chevron}
      </button>
    </li>
  );
};

/** A thin bar for a share, as the rows of a table carry it. */
export const ShareBar = ({
  share,
  label,
}: {
  share: number;
  label: string;
}) => (
  <Progress aria-label={label} value={Math.min(100, Math.round(share * 100))} />
);

/** What is new against the span before, or how much it grew; nothing for what held level or fell. */
export const Growth = ({ grew }: { grew: "new" | number | null }) => {
  const { t } = useLingui();
  if (grew === null) {
    return null;
  }
  const by = formatPercent(grew === "new" ? 0 : grew);
  return (
    <span className="text-status-agreed flex-none text-xs tabular-nums">
      {grew === "new"
        ? t({ message: "New", context: "asked for the first time this span" })
        : t`+${by}`}
    </span>
  );
};
