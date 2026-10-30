import type { Workspace } from "@grasp-os/shared/brain";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AppLogo } from "../../connections/app-logo.tsx";
import { formatList } from "../../format.ts";
import { teamOfWork } from "../brain-atlas.ts";
import { brainLinks } from "../brain-links.ts";
import type { BrainLink } from "../brain-links.ts";
import type { Brain, Note } from "../brain.ts";
import { Mark } from "../region-marks.tsx";
import { PartHeading } from "./kern.tsx";

/** A link as a row: a short line, whole when it is confirmed and dashed while it is only proposed, the words, and "Proposed" where it is. */
const LinkRow = ({
  link,
  children,
}: {
  link: BrainLink;
  children: ReactNode;
}) => (
  <li className="flex items-center gap-2.5 border-t py-2.5 text-sm first:border-t-0">
    <span
      aria-hidden="true"
      className={
        link.confirmed
          ? "border-foreground/60 w-4 flex-none border-t-2"
          : "border-foreground/60 w-4 flex-none border-t-2 border-dashed"
      }
    />
    {children}
    {link.confirmed ? null : (
      <span className="text-muted-foreground text-xs">
        <Trans context="a link Grasp proposed that nobody confirmed yet">
          Proposed
        </Trans>
      </span>
    )}
  </li>
);

/**
 * A team's page, after its size, as the prototype has it
 * (`components/brain-article/team-work.tsx`): the work it does, where that
 * work passes to another team, the same pain other teams told too, and the
 * systems it works in. What its people said lives on the pages of the
 * work; here nobody is quoted, and nothing says how many talked. A link
 * Grasp only proposed says so, and is drawn dashed, as in the brain. The
 * links are what core already serves: the statements they rest on
 * (brain-links.ts); a person's yes to one is not kept yet.
 */
export const TeamWork = ({
  team,
  brain,
  ws,
}: {
  team: Note;
  brain: Brain;
  ws: Workspace;
}) => {
  const { t } = useLingui();
  const work = brain.notes.filter(
    (note) => note.kind === "candidate" && teamOfWork(ws, note) === team.id
  );
  const links = brainLinks(ws).filter((link) => link.teams.includes(team.id));
  const handovers = links.filter((link) => link.kind === "handover");
  const pains = links.filter((link) => link.kind === "samePain");
  const systems = brain.notes.filter(
    (note) =>
      note.kind === "tool" &&
      ws.tools
        .find((tool) => tool.id === note.id)
        ?.teamIds.includes(team.id) === true
  );
  const teamName = (id: string) =>
    ws.teams.find((each) => each.id === id)?.name ?? id;
  const workName = (id: string) =>
    brain.notes.find((note) => note.id === id)?.title ??
    ws.candidates.find((each) => each.id === id)?.name ??
    id;
  const others = (link: BrainLink) => link.teams.filter((id) => id !== team.id);

  return (
    <>
      {work.length > 0 ? (
        <section className="flex flex-col gap-2">
          <PartHeading title={t`Its work`} />
          <ul className="flex flex-col">
            {work.map((note) => (
              <li
                className="flex items-center gap-2.5 border-t py-2.5 text-sm first:border-t-0"
                key={note.id}
              >
                <Mark
                  state={note.tags.includes("drawn") ? "known" : "waiting"}
                />
                <Link
                  className="min-w-0 flex-1 truncate hover:underline"
                  params={{ noteId: note.id }}
                  to="/brain/$noteId"
                >
                  {note.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {handovers.length > 0 ? (
        <section className="flex flex-col gap-2">
          <PartHeading title={t`Where the work passes on`} />
          <ul className="flex flex-col">
            {handovers.map((link) => {
              const name = workName(link.work);
              const teams = formatList(others(link).map(teamName));
              return (
                <LinkRow key={link.id} link={link}>
                  <span className="min-w-0 flex-1">
                    <Trans context="a handover: the work passes between this team and these">
                      {name} · with {teams}
                    </Trans>
                  </span>
                </LinkRow>
              );
            })}
          </ul>
        </section>
      ) : null}

      {pains.length > 0 ? (
        <section className="flex flex-col gap-2">
          <PartHeading title={t`The same pain in other teams`} />
          <ul className="flex flex-col">
            {pains.map((link) => {
              const name = workName(link.work);
              const teams = formatList(others(link).map(teamName));
              return (
                <LinkRow key={link.id} link={link}>
                  <span className="min-w-0 flex-1">
                    <Trans context="the same pain: these teams told it too">
                      {name} · also {teams}
                    </Trans>
                  </span>
                </LinkRow>
              );
            })}
          </ul>
        </section>
      ) : null}

      {systems.length > 0 ? (
        <section className="flex flex-col gap-2">
          <PartHeading title={t`Works in`} />
          <div className="flex flex-wrap gap-2">
            {systems.map((note) => (
              <Tooltip key={note.id}>
                <TooltipTrigger
                  render={
                    <Link
                      aria-label={note.title}
                      className="focus-visible:ring-ring/50 rounded-md outline-none focus-visible:ring-3"
                      params={{ noteId: note.id }}
                      to="/brain/$noteId"
                    />
                  }
                >
                  <AppLogo logo={note.logoSrc} name={note.title} />
                </TooltipTrigger>
                <TooltipContent>{note.title}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
};
