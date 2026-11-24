import type { SubjectKind } from "@grasp-os/shared/subject";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Link } from "@grasp-os/ui/components/link";
import { Shimmer } from "@grasp-os/ui/components/shimmer";
import type { IconData } from "@grasp-os/ui/lib/icons";
// Damsko's icon module has no window: Hugeicons' own, as #2503's strip
// draws an App (its `AppWindow`).
import { AppWindowIcon } from "@hugeicons/core-free-icons";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link as RouterLink } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import type { NamedWork } from "./builds.tsx";
import type { SubjectBar } from "./composer.tsx";
import { useMentionKinds } from "./mentions.tsx";

// What the chat is about and what it worked on, on the band above its box
// (the box's PromptInputBanner, tucked under its top, as #2503's
// ComposerSurface): the kind's mark, the name, and "+N" at its end. On a
// page about one thing (chat-subject.ts), that thing; elsewhere the App or
// workflow the chat changed last, a way to its page, which carries this
// chat on beside it (`?chat=`). Anything else it worked on waits behind
// "+N", the latest first. Each says "Building…" while the running turn
// writes its draft. Nothing worked on and no subject: no bar.

/** One thing on the bar: of a kind, by ID and name. */
interface Worked {
  kind: SubjectKind;
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
const subjectBarOf = (
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
}) =>
  worked.kind === "app" ? (
    <RouterLink
      {...props}
      params={{ app: worked.id }}
      search={chatId === undefined ? {} : { chat: chatId }}
      to="/apps/$app"
    />
  ) : (
    <RouterLink
      {...props}
      params={{ workflow: worked.id }}
      search={
        chatId === undefined ? { view: "flow" } : { chat: chatId, view: "flow" }
      }
      to="/workflows/$workflow"
    />
  );

/** What stands for a subject on the strip: an App as a window, as #2503's; anything else as a mention does. */
const iconOf = (
  kind: SubjectKind,
  kinds: ReturnType<typeof useMentionKinds>
): IconData => (kind === "app" ? AppWindowIcon : kinds[kind].icon);

/**
 * The band's line and its "+N": `subject`, the page's, or else the latest
 * of `work`, and the rest behind "+N"; each building where the running
 * turn, begun at `since`, wrote its draft. None where there is neither.
 */
export const useSubjectBar = ({
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
}): SubjectBar | undefined => {
  const { t } = useLingui();
  const kinds = useMentionKinds();
  const shown = subjectBarOf(subject, work);
  if (shown === undefined) {
    return undefined;
  }
  const { lead, others } = shown;
  // What the running turn wrote: their checkpoints of this chat moved
  // since it began.
  const written = new Set(
    since === undefined
      ? []
      : work
          .filter((each) => each.work.updatedAt >= since)
          .map((each) => `${each.work.kind}:${each.work.id}`)
  );
  const building = (worked: Worked): boolean =>
    written.has(`${worked.kind}:${worked.id}`);
  const count = others.length;
  return {
    icon: iconOf(lead.kind, kinds),
    line: (
      <>
        {subject === undefined ? (
          <Link asChild variant="plain">
            <WorkedLink chatId={chatId} worked={lead}>
              {lead.name}
            </WorkedLink>
          </Link>
        ) : (
          lead.name
        )}
        {building(lead) ? (
          <>
            {" · "}
            <Shimmer>{t`Building…`}</Shimmer>
          </>
        ) : null}
      </>
    ),
    more:
      count === 0 ? undefined : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={t`${plural(count, {
                one: "# more thing this chat worked on",
                other: "# more things this chat worked on",
              })}`}
              size="xs"
              variant="ghost"
            >
              +{count}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <Trans>Also worked on</Trans>
              </DropdownMenuLabel>
              {others.map((worked) => (
                <DropdownMenuItem
                  asChild
                  icon={iconOf(worked.kind, kinds)}
                  key={`${worked.kind}:${worked.id}`}
                >
                  <WorkedLink chatId={chatId} worked={worked}>
                    {worked.name}
                    {building(worked) ? (
                      <>
                        {" "}
                        <Shimmer>{t`Building…`}</Shimmer>
                      </>
                    ) : null}
                  </WorkedLink>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
  };
};
