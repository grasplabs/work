import type { Workspace } from "@grasp-os/shared/brain";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AppLogo } from "../../connections/app-logo.tsx";
import { formatList } from "../../format.ts";
import { focus } from "../../grasp/focus/focus.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { teamOfWork } from "../brain-atlas.ts";
import { brainLinks } from "../brain-links.ts";
import type { BrainLink } from "../brain-links.ts";
import type { Brain, Note } from "../brain.ts";
import { Mark } from "../region-marks.tsx";
import { PartHeading } from "./kern.tsx";

const styles = stylex.create({
  part: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    paddingBlock: grasp.space3,
    borderTopWidth: { default: grasp.hairline, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
  // A short line: whole when the link is confirmed, dashed while it is only proposed.
  stroke: {
    flexShrink: 0,
    width: grasp.space4,
    borderTopWidth: 2,
    borderTopStyle: "solid",
    borderTopColor: grasp.muted,
  },
  proposedStroke: { borderTopStyle: "dashed" },
  proposed: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  grow: { flexGrow: 1, minWidth: 0 },
  work: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "inherit",
    textDecorationLine: { default: "none", ":hover": "underline" },
  },
  systems: {
    display: "flex",
    flexWrap: "wrap",
    gap: grasp.space2,
  },
  system: {
    display: "inline-flex",
    borderRadius: grasp.cornerMark,
  },
});

/** A link as a row: a short line, whole when it is confirmed and dashed while it is only proposed, the words, and "Proposed" where it is. */
const LinkRow = ({
  link,
  children,
}: {
  link: BrainLink;
  children: ReactNode;
}) => (
  <li {...stylex.props(styles.row)}>
    <span
      aria-hidden="true"
      {...stylex.props(styles.stroke, !link.confirmed && styles.proposedStroke)}
    />
    {children}
    {link.confirmed ? null : (
      <span {...stylex.props(styles.proposed)}>
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
        <section {...stylex.props(styles.part)}>
          <PartHeading title={t`Its work`} />
          <ul {...stylex.props(styles.list)}>
            {work.map((note) => (
              <li key={note.id} {...stylex.props(styles.row)}>
                <Mark
                  state={note.tags.includes("drawn") ? "known" : "waiting"}
                />
                <Link
                  params={{ noteId: note.id }}
                  to="/brain/$noteId"
                  {...stylex.props(styles.work, focus.words)}
                >
                  {note.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {handovers.length > 0 ? (
        <section {...stylex.props(styles.part)}>
          <PartHeading title={t`Where the work passes on`} />
          <ul {...stylex.props(styles.list)}>
            {handovers.map((link) => {
              const name = workName(link.work);
              const teams = formatList(others(link).map(teamName));
              return (
                <LinkRow key={link.id} link={link}>
                  <span {...stylex.props(styles.grow)}>
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
        <section {...stylex.props(styles.part)}>
          <PartHeading title={t`The same pain in other teams`} />
          <ul {...stylex.props(styles.list)}>
            {pains.map((link) => {
              const name = workName(link.work);
              const teams = formatList(others(link).map(teamName));
              return (
                <LinkRow key={link.id} link={link}>
                  <span {...stylex.props(styles.grow)}>
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
        <section {...stylex.props(styles.part)}>
          <PartHeading title={t`Works in`} />
          <div {...stylex.props(styles.systems)}>
            {systems.map((note) => (
              // Its name on the link, and as the pointer's hint over the logo.
              <Link
                aria-label={note.title}
                key={note.id}
                params={{ noteId: note.id }}
                title={note.title}
                to="/brain/$noteId"
                {...stylex.props(styles.system, focus.ring)}
              >
                <AppLogo logo={note.logoSrc} name={note.title} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
};
