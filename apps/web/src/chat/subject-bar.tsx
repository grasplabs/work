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
import { Shimmer } from "@grasp-os/ui/components/shimmer";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import type { NamedWork } from "./builds.tsx";
import { useMentionKinds } from "./mentions.tsx";

// What the chat is about and what it worked on, on the bar above its box
// (`PromptInputSubjectBar`): one line, so the box stays as it is. On a
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
}) =>
  worked.kind === "app" ? (
    <Link
      {...props}
      params={{ app: worked.id }}
      search={chatId === undefined ? {} : { chat: chatId }}
      to="/apps/$app"
    />
  ) : (
    <Link
      {...props}
      params={{ workflow: worked.id }}
      search={chatId === undefined ? {} : { chat: chatId }}
      to="/workflows/$workflow"
    />
  );

/**
 * The bar's line: `subject`, the page's, or else the latest of `work`,
 * and the rest behind "+N"; each building where the running turn, begun
 * at `since`, wrote its draft.
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
  const kinds = useMentionKinds();
  const shown = subjectBarOf(subject, work);
  if (shown === undefined) {
    return null;
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
  return (
    <>
      {kinds[lead.kind].icon}
      {subject === undefined ? (
        <WorkedLink chatId={chatId} worked={lead}>
          {lead.name}
        </WorkedLink>
      ) : (
        <span>{lead.name}</span>
      )}
      {building(lead) ? <Shimmer as="span">{t`Building…`}</Shimmer> : null}
      {count === 0 ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t`${plural(count, {
                  one: "# more thing this chat worked on",
                  other: "# more things this chat worked on",
                })}`}
                className="-my-1 ms-auto"
                size="xs"
                variant="ghost"
              />
            }
          >
            +{count}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <Trans>Also worked on</Trans>
              </DropdownMenuLabel>
              {others.map((worked) => (
                <DropdownMenuItem
                  key={`${worked.kind}:${worked.id}`}
                  render={<WorkedLink chatId={chatId} worked={worked} />}
                >
                  {kinds[worked.kind].icon}
                  <span className="truncate">{worked.name}</span>
                  {building(worked) ? (
                    <Shimmer as="span" className="ms-auto">
                      {t`Building…`}
                    </Shimmer>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
};
