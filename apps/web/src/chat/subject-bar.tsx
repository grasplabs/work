import type { ChatSubjectKind } from "@grasp-os/shared/chat";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import { ComposerSurface } from "../grasp/composer/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { AppWindow, Workflow } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Shimmer } from "../grasp/shimmer/index.ts";
import type { NamedWork } from "./builds.tsx";

// What the chat is about and what it worked on, on the band above its box
// (Grasp UI's ComposerSurface): one line, so the box stays as it is. On a
// page about one thing (chat-subject.ts), that thing; elsewhere the App
// the chat changed last, a way into its workspace, which carries this
// chat on beside the App (`?chat=`). Anything else it worked on waits
// behind "+N", the latest first. Nothing worked on and no subject: no
// bar.

/** One thing on the bar: of a kind, by ID and name. */
interface Worked {
  kind: ChatSubjectKind;
  id: string;
  name: string;
}

/** What the chat worked on, what it changed last first. */
const latestFirst = (work: readonly NamedWork[]): NamedWork[] =>
  work.toSorted((a, b) => b.work.updatedAt.localeCompare(a.work.updatedAt));

const workedOn = ({ work, name }: NamedWork): Worked => ({
  kind: work.kind,
  id: work.id,
  name,
});

/**
 * What the bar shows: the page's `subject`, else the latest of `work`,
 * first; the rest after it. None where there is neither.
 */
export const subjectBarOf = (
  subject: Worked | undefined,
  work: readonly NamedWork[]
): { lead: Worked; others: Worked[] } | undefined => {
  const worked = latestFirst(work).map(workedOn);
  const [lead, ...others] =
    subject === undefined
      ? worked
      : [
          subject,
          ...worked.filter(
            ({ kind, id }) => kind !== subject.kind || id !== subject.id
          ),
        ];
  return lead === undefined ? undefined : { lead, others };
};

/** Where `worked` is built, carrying `chatId` on. */
const WorkedLink = ({
  worked,
  chatId,
  ...props
}: Omit<ComponentProps<"a">, "href"> & {
  worked: Worked;
  chatId: string | undefined;
}) => (
  <Link
    {...props}
    params={{ app: worked.id }}
    search={chatId === undefined ? {} : { chat: chatId }}
    to="/apps/$app"
  />
);

/** Each kind's mark on the band. */
const kindIcons: Record<ChatSubjectKind, IconData> = {
  app: AppWindow,
  workflow: Workflow,
};

/** What else the chat worked on, behind "+N": each opens where it is built. */
const AlsoWorkedOn = ({
  others,
  chatId,
  building,
}: {
  others: readonly Worked[];
  chatId: string | undefined;
  building: (worked: Worked) => boolean;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const count = others.length;
  const buildingName = (name: string): string => t`${name}, building`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`${plural(count, {
          one: "# more App this chat worked on",
          other: "# more Apps this chat worked on",
        })}`}
        size="xs"
        variant="ghost"
      >
        {`+${String(count)}`}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t`Also worked on`}</DropdownMenuLabel>
          {others.map((worked) => (
            <DropdownMenuItem
              icon={kindIcons[worked.kind]}
              key={`${worked.kind}:${worked.id}`}
              onClick={() => {
                void navigate({
                  params: { app: worked.id },
                  search: chatId === undefined ? {} : { chat: chatId },
                  to: "/apps/$app",
                });
              }}
            >
              {building(worked) ? buildingName(worked.name) : worked.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * The band's line: `subject`, the page's, or else the latest of `work`,
 * with the rest behind "+N"; building where the running turn, begun at
 * `since`, wrote its draft.
 */
export const SubjectBarContent = ({
  subject,
  work,
  chatId,
  since,
}: {
  subject: Worked | undefined;
  work: readonly NamedWork[];
  chatId: string | undefined;
  /** When the running turn began (ISO 8601); none while nothing runs. */
  since: string | undefined;
}) => {
  const { t } = useLingui();
  const shown = subjectBarOf(subject, work);
  if (shown === undefined) {
    return null;
  }
  const { lead, others } = shown;
  // The Apps the running turn wrote: their undo points of this chat moved
  // since it began.
  const written = new Set(
    since === undefined
      ? []
      : work
          .filter((each) => each.work.updatedAt >= since)
          .map((each) => each.work.id)
  );
  const building = (worked: Worked): boolean =>
    worked.kind === "app" && written.has(worked.id);
  return (
    <ComposerSurface
      action={
        others.length === 0 ? undefined : (
          <AlsoWorkedOn building={building} chatId={chatId} others={others} />
        )
      }
      icon={kindIcons[lead.kind]}
    >
      {subject === undefined ? (
        <WorkedLink chatId={chatId} worked={lead}>
          {lead.name}
        </WorkedLink>
      ) : (
        <span>{lead.name}</span>
      )}
      {building(lead) ? (
        <>
          {" · "}
          <Shimmer active>{t`Building…`}</Shimmer>
        </>
      ) : null}
    </ComposerSurface>
  );
};
