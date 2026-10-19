/**
 * What Grasp keeps of the interviews at one company, ported from the
 * prototype (grasplabs/prototype `components/admin/org-data.tsx`): what is
 * kept and what never is, who had their interview deleted, and what the
 * company itself gets to see. Every figure is the model's (`keptOf`,
 * `companySees`); nothing anyone said is shown, only names and numbers.
 *
 * Not here, as the prototype has it: the number of words in the first
 * conversation (the console never holds what was said, so it says only how
 * far that conversation is), and the way to the transcripts (core keeps
 * them back).
 */
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { MIN_GROUP } from "@grasp-os/shared/admin/interviews";
import { DELETE_DAYS, peopleOf } from "@grasp-os/shared/admin/onboarding-admin";
import type { OrgState } from "@grasp-os/shared/admin/onboarding-admin";
import {
  companySees,
  keptOf,
} from "@grasp-os/shared/admin/onboarding-admin-record";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { ReactNode } from "react";

import { Panel } from "./panel.tsx";

const percent = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 0,
});

/** So many of so many, as a share; nothing of nothing has none. */
const share = (done: number, of: number): string =>
  of === 0 ? "–" : percent.format(done / of);

/** `count` people, in words. */
const peopleWords = (count: number): string =>
  `${count} ${count === 1 ? "person" : "people"}`;

/** How far the first conversation is, as the model has it: never its words. */
const conversationWords: Record<OrgState["conversation"], string> = {
  none: "Not brought in yet",
  in: "Brought in",
  read: "Read by Stephen",
};

/** One thing that is kept or not: what it is and why on the left, how much of it on the right. */
const Kept = ({
  label,
  what,
  children,
}: {
  label: string;
  what: string;
  children: ReactNode;
}) => (
  <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-1 border-t px-5 py-3">
    <div className="flex min-w-0 flex-col gap-0.5">
      <span>{label}</span>
      <p className="text-muted-foreground">{what}</p>
    </div>
    <span className="tabular-nums">{children}</span>
  </div>
);

const WhatIsKept = ({ view }: { view: AdminView }) => {
  // Counted up to the day the view is on, which runs on past the interviews' close.
  const kept = keptOf(view, view.asOf);
  const { conversation } = view.state;
  return (
    <Panel
      description="As people are told before their interview starts."
      title="What is kept"
    >
      <Kept
        label="The first conversation"
        what="With the sponsor, word for word. It is what the research and Stephen’s first questions start from."
      >
        <span
          className={
            conversation === "none" ? "text-muted-foreground" : undefined
          }
        >
          {conversationWords[conversation]}
        </span>
      </Kept>
      <Kept
        label="Interviews people agreed to"
        what="Their words are kept, and what they said counts."
      >
        {kept.agreed}
      </Kept>
      <Kept
        label="Interviews that stopped halfway"
        what="Kept, so the link carries on where they stopped. Nothing in them counts."
      >
        {kept.halfway}
      </Kept>
      <Kept
        label="Anyone’s voice"
        what="What is said is written out, and the sound is gone."
      >
        Never kept
      </Kept>
      <Kept
        label="Can still be deleted"
        what={`For ${DELETE_DAYS} days after their interview, the person can ask.`}
      >
        {kept.deletable}
      </Kept>
    </Panel>
  );
};

const Deleted = ({ view }: { view: AdminView }) => {
  const { org, state } = view;
  const deleted = peopleOf(org).filter((person) =>
    state.deleted.includes(person.id)
  );
  return (
    <Panel
      description="Their words are gone, and with them what only they said. Their name stays, so nobody is asked again."
      title="Deleted because they asked"
    >
      {deleted.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          Nobody asked.
        </p>
      ) : (
        <ul className="flex flex-col">
          {deleted.map((person) => (
            <li
              className="flex flex-wrap items-center justify-between gap-x-6 gap-y-0.5 border-t px-5 py-2.5"
              key={person.id}
            >
              <span>{person.name}</span>
              <span className="text-muted-foreground">
                {org.teams.find((team) => team.id === person.team)?.name ?? ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
};

/** A row's numbers: its people, and how many completed and stopped, none for a team too small to show. */
const Figures = ({
  people,
  completed,
  stopped,
}: {
  people: number;
  completed: number | null;
  stopped: number | null;
}) => (
  <>
    <TableCell className="hidden text-right @sm:table-cell" variant="card">
      <span className="tabular-nums">{people}</span>
    </TableCell>
    <TableCell className="text-right" variant="card">
      <span className="tabular-nums">{completed ?? "–"}</span>
    </TableCell>
    <TableCell className="hidden text-right @3xl:table-cell" variant="card">
      <span className="tabular-nums">{stopped ?? "–"}</span>
    </TableCell>
    <TableCell className="hidden text-right @xl:table-cell" variant="card">
      <span className="tabular-nums">
        {completed === null ? "–" : share(completed, people)}
      </span>
    </TableCell>
  </>
);

const CompanySees = ({ view }: { view: AdminView }) => {
  const sees = companySees(view);
  return (
    <Panel
      description={`Numbers per team, only where ${MIN_GROUP} or more in a team are asked to talk, and for everyone only the teams that show theirs. Never a name, never anyone’s words, and never who stopped or did not start.`}
      title="What the company itself sees"
    >
      {sees.teams.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          Nothing yet. The teams come with the company’s own sign-in.
        </p>
      ) : (
        <div className="@container border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="card">Team</TableHead>
                <TableHead
                  className="hidden text-right @sm:table-cell"
                  variant="card"
                >
                  People
                </TableHead>
                <TableHead className="text-right" variant="card">
                  Completed
                </TableHead>
                <TableHead
                  className="hidden text-right @3xl:table-cell"
                  variant="card"
                >
                  Stopped halfway
                </TableHead>
                <TableHead
                  className="hidden text-right @xl:table-cell"
                  variant="card"
                >
                  Share completed
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sees.teams.map((team) => (
                <TableRow key={team.team.id}>
                  <TableCell className="whitespace-normal" variant="card">
                    <span className="flex flex-col">
                      {team.team.name}
                      {/* Where there is no room for a column of its own, the number of people goes under the name. */}
                      <span className="text-muted-foreground text-xs tabular-nums @sm:hidden">
                        {peopleWords(team.people)}
                      </span>
                      {team.shown ? null : (
                        <span className="text-muted-foreground text-xs">
                          Too small to show
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <Figures
                    completed={team.shown ? team.completed : null}
                    people={team.people}
                    stopped={team.shown ? team.stopped : null}
                  />
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell variant="card">
                  <span className="flex flex-col">
                    Everyone
                    <span className="text-muted-foreground text-xs font-normal tabular-nums @sm:hidden">
                      {peopleWords(sees.people)}
                    </span>
                  </span>
                </TableCell>
                <Figures
                  completed={sees.completed}
                  people={sees.people}
                  stopped={sees.stopped}
                />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </Panel>
  );
};

/** An organization's Data: what is kept, what was deleted, and what the company sees. */
export const OrgData = ({ view }: { view: AdminView }) => (
  <>
    <WhatIsKept view={view} />
    <Deleted view={view} />
    <CompanySees view={view} />
  </>
);
