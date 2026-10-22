import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import type { OrgView } from "@grasp-os/shared/admin/onboarding-admin";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { SettingsSection } from "../settings/settings-parts.tsx";
import { dayDate, phaseTitles } from "./interview-words.ts";

// The interviews one by one (prototype `org-transcripts.tsx`): every one
// that was finished or stopped halfway, with how long it took, how much
// was agreed to, how the person rated it and who held it. A name opens
// its transcript, and every one opened is on record. The company never
// sees anyone's words.

const shows = ["all", "stopped"] as const;
type Shows = (typeof shows)[number];

export const InterviewList = ({
  view,
  snapshot,
}: {
  view: OrgView;
  snapshot: AdminSnapshot;
}) => {
  const { t, i18n } = useLingui();
  const [show, setShow] = useState<Shows>("all");
  const teams = new Map(view.teams.map((team) => [team.team.id, team]));
  const held = new Map(snapshot.interviews.map((one) => [one.person, one]));
  const shown = view.interviews.filter(
    (interview) => show === "all" || !interview.approved
  );
  const labels: Record<Shows, string> = {
    all: t({ message: "All", context: "filter: every interview" }),
    stopped: t`Stopped halfway`,
  };
  let empty = t`No interviews yet. They start once the company has told its team.`;
  if (view.told) {
    empty = t`No interviews yet. The team leads go first.`;
  }
  return (
    <SettingsSection
      action={
        view.interviews.length > 0 ? (
          <ToggleGroup
            aria-label={t`Which interviews to show`}
            onValueChange={(value) => {
              const picked = shows.find((each) => each === value[0]);
              if (picked !== undefined) {
                setShow(picked);
              }
            }}
            size="sm"
            spacing={0}
            value={[show]}
            variant="outline"
          >
            {shows.map((each) => (
              <ToggleGroupItem key={each} value={each}>
                {labels[each]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null
      }
      description={t`Every interview, finished or stopped halfway. A name opens what was said, and every transcript read is in the audit log; the company never sees anyone's words.`}
      title={t`Transcripts`}
    >
      {view.interviews.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">{empty}</p>
      ) : (
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="card">
                  {t({
                    message: "Who",
                    context: "column: who was interviewed",
                  })}
                </TableHead>
                <TableHead variant="card">
                  {t({
                    message: "When",
                    context: "column: when an interview was held",
                  })}
                </TableHead>
                <TableHead className="hidden md:table-cell" variant="card">
                  {t({
                    message: "With",
                    context: "column: who held an interview",
                  })}
                </TableHead>
                <TableHead className="text-right" variant="card">
                  {t({
                    message: "Minutes",
                    context: "column: how long an interview took",
                  })}
                </TableHead>
                <TableHead className="text-right" variant="card">
                  {t`Facts agreed`}
                </TableHead>
                <TableHead
                  className="hidden text-right md:table-cell"
                  variant="card"
                >
                  {t({
                    message: "Rating",
                    context: "column: how the person rated their interview",
                  })}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((interview) => {
                const { name } = interview.person;
                const team = teams.get(interview.person.team);
                const kept = interview.approved
                  ? interview.facts - interview.out
                  : 0;
                const written = interview.facts;
                const rating = held.get(interview.id)?.rating ?? null;
                const part =
                  interview.stoppedAt === null
                    ? ""
                    : i18n._(phaseTitles[interview.stoppedAt]);
                return (
                  <TableRow key={interview.id}>
                    <TableCell className="whitespace-normal" variant="card">
                      <span className="flex flex-col">
                        <Link
                          aria-label={t`Read the transcript of ${name}`}
                          className="underline-offset-4 hover:underline"
                          params={{ person: interview.id }}
                          to="/onboarding/interviews/$person"
                        >
                          {name}
                        </Link>
                        <span className="text-muted-foreground text-xs">
                          {team?.team.name ?? ""}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal" variant="card">
                      <span className="flex flex-col">
                        {dayDate(view, interview.day)}
                        {part === "" ? null : (
                          <span className="text-muted-foreground text-xs">
                            {t`Stopped at: ${part}`}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="hidden md:table-cell" variant="card">
                      {interviewerNames[interview.interviewer]}
                    </TableCell>
                    <TableCell className="text-right" variant="card">
                      <span className="tabular-nums">
                        {interview.minutes ?? "–"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right" variant="card">
                      <span className="tabular-nums">
                        {t`${kept} of ${written}`}
                      </span>
                    </TableCell>
                    <TableCell
                      className="hidden text-right md:table-cell"
                      variant="card"
                    >
                      <span className="tabular-nums">{rating ?? "–"}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {shown.length === 0 ? (
            <p className="text-muted-foreground border-t px-5 py-4">
              {t`None right now.`}
            </p>
          ) : null}
        </div>
      )}
    </SettingsSection>
  );
};
