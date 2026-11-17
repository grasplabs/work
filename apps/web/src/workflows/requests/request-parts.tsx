import { chatPlatformName } from "@grasp-os/shared/chat";
import type {
  RequestsPage,
  RequestTool,
} from "@grasp-os/shared/stephen-requests";
import { brainTool, elsewhere } from "@grasp-os/shared/stephen-requests";
import { useLingui } from "@lingui/react/macro";

import { formatPercent } from "../../format.ts";
import { Badge } from "../../grasp/badge/index.ts";
import { BrandIcon, brands } from "../../grasp/brand-icon/index.ts";
import type { Brand } from "../../grasp/brand-icon/index.ts";
import {
  AppWindow,
  Brain,
  Chat,
  Icon,
  Tool,
  Workflow,
} from "../../grasp/icons/index.ts";
import type { IconData } from "../../grasp/icons/index.ts";

// The parts every block of Workflows › Requests shares, as the prototype's
// `components/requests/request-parts.tsx`: names for what the report
// counts by id, marks for the tools and places, and what grew.

/**
 * The brand a place or an app is of, where Grasp has its mark: a place by
 * its platform ("teams"), an app by the part of a tool before its action
 * ("microsoft" of "microsoft.mail"); none for any other.
 */
const isBrand = (key: string): key is Brand => Object.hasOwn(brands, key);

/** A place's name, as people know it. */
export const placeName = (place: string): string => chatPlatformName(place);

/**
 * A place's mark, by size: `xs` and `inline` the mark alone beside words,
 * `sm` and `default` on its tile, as a row's face. A place Grasp has no
 * mark for shows a chat's.
 */
export const PlaceLogo = ({
  place,
  size = "xs",
}: {
  place: string;
  size?: "xs" | "inline" | "sm" | "default";
}) => {
  if (!isBrand(place)) {
    return <Icon icon={Chat} label={placeName(place)} />;
  }
  return size === "xs" || size === "inline" ? (
    <BrandIcon brand={place} size="sm" tile={false} />
  ) : (
    <BrandIcon brand={place} size={size === "sm" ? "xs" : "sm"} />
  );
};

/** A place's mark as an icon, for a row that takes one. */
export const placeIcon = (place: string): IconData =>
  isBrand(place) ? brands[place].mark : Chat;

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

/**
 * A tool's mark: the brain, a workflow, an App, the mark of the app an
 * action is in where Grasp has one, or a tool's.
 */
export const toolIcon = (tool: RequestTool): IconData => {
  if (tool === brainTool) {
    return Brain;
  }
  if (tool.startsWith("workflow:")) {
    return Workflow;
  }
  if (tool.startsWith("app:") || tool === elsewhere) {
    return AppWindow;
  }
  const [app = tool] = tool.split(".");
  return isBrand(app) ? brands[app].mark : Tool;
};

/** A tool's mark, named for a screen reader. */
export const ToolMark = ({
  tool,
  label,
}: {
  tool: RequestTool;
  label: string;
}) => <Icon icon={toolIcon(tool)} label={label} />;

/** What is new against the span before, or how much it grew; nothing for what held level or fell. */
export const Growth = ({ grew }: { grew: "new" | number | null }) => {
  const { t } = useLingui();
  if (grew === null) {
    return null;
  }
  const by = formatPercent(grew === "new" ? 0 : grew);
  return (
    <Badge size="sm" tone="success">
      {grew === "new"
        ? t({ message: "New", context: "asked for the first time this span" })
        : t`+${by}`}
    </Badge>
  );
};
