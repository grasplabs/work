import type { Statement } from "@grasp-os/shared/brain";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { formatDay, isoWeek } from "../../format.ts";
import { Avatar, AvatarFallback } from "../../grasp/avatar/index.ts";
import { Collapsible } from "../../grasp/collapsible/index.ts";
import { focus } from "../../grasp/focus/focus.ts";
import { Heading } from "../../grasp/heading/index.ts";
import { Trash } from "../../grasp/icons/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../grasp/tooltip/index.ts";
import { ClaimBasis } from "../aggregate.tsx";
import type { Interviewee, Kern, StatementRow } from "../article-kern.ts";
import { Drawing, Panel } from "../brain-home.tsx";
import { given, groupOf, isTeamClaim, statementWords } from "../brain.ts";
import type { Note } from "../brain.ts";
import { KindLabel } from "../statement-kind.tsx";

// The pieces of a note's article, as the prototype has them
// (`components/brain-article/kern.tsx`).

const styles = stylex.create({
  lastHeard: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    marginInlineStart: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.success,
    whiteSpace: "nowrap",
  },
  heardDot: {
    width: grasp.severityDot,
    height: grasp.severityDot,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.success,
  },
  people: {
    display: "flex",
  },
  // Each face after the first stands a little back over the one before; the one pointed at comes forward.
  person: {
    position: "relative",
    display: "inline-flex",
    borderRadius: grasp.cornerCircle,
    textDecorationLine: "none",
    marginInlineStart: {
      default: `calc(-1 * ${grasp.space2})`,
      ":first-child": 0,
    },
    zIndex: { default: null, ":hover": 1, ":focus-visible": 1 },
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
  },
  sticker: {
    position: "absolute",
    insetBlockEnd: grasp.space4,
    insetInlineStart: grasp.space5,
  },
  titles: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space1,
    minWidth: 0,
  },
  line: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "baseline",
    gap: grasp.space4,
    paddingBlock: grasp.space3,
    borderTopWidth: { default: grasp.hairline, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
  lineRemovable: {
    gridTemplateColumns: "minmax(0, 1fr) auto auto",
  },
  said: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space1,
    minWidth: 0,
  },
  words: {
    color: "inherit",
    textDecorationLine: { default: "none", ":hover": "underline" },
  },
  kind: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  where: {
    maxWidth: `calc(4 * ${grasp.space16})`,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "end",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: { default: grasp.muted, ":hover": grasp.ink },
    textDecorationLine: { default: "none", ":hover": "underline" },
  },
  remove: { alignSelf: "center" },
  // Each line of who a face is, on its own line in the tooltip.
  tipLine: { display: "block" },
  partHeading: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space3,
  },
  count: {
    marginInlineStart: grasp.space2,
    fontWeight: grasp.weightRegular,
    color: grasp.muted,
  },
  fold: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
    paddingTop: grasp.space2,
    paddingBottom: grasp.space4,
  },
});

/** When the team was last heard: the date of the newest conversation, so the reader knows how fresh it is. */
export const LastHeard = ({ date }: { date: string }) => {
  const day = formatDay(date);
  return (
    <span {...stylex.props(styles.lastHeard)}>
      <span aria-hidden="true" {...stylex.props(styles.heardDot)} />
      <Trans>Last heard {day}</Trans>
    </span>
  );
};

/** Who an interviewee is, as their face says when pointed at: name, role, and how and when they were interviewed. */
const useWhoLines = (person: Interviewee): string[] => {
  const { t } = useLingui();
  const day = formatDay(person.date);
  return [
    person.label,
    person.label === person.role ? undefined : person.role,
    [person.stakeholder ? t`Stakeholder` : t`Employee`, person.how, day]
      .filter(given)
      .join(" · "),
  ].filter(given);
};

/** One interviewee's face, a link to their interview. */
const Face = ({ person }: { person: Interviewee }) => {
  const { t } = useLingui();
  const day = formatDay(person.date);
  const who = person.label;
  const lines = useWhoLines(person);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            aria-label={t`${who}, interviewed ${day}`}
            params={{ noteId: person.sourceId }}
            to="/brain/$noteId"
            {...stylex.props(styles.person, focus.ring)}
          >
            <Avatar decorative name={person.label} size="md">
              <AvatarFallback>{person.initials}</AvatarFallback>
            </Avatar>
          </Link>
        }
      />
      <TooltipContent>
        {lines.map((line) => (
          <span key={line} {...stylex.props(styles.tipLine)}>
            {line}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
};

/**
 * Everyone the team was heard through in an interview, as initials on the banner. Pointing at one
 * says who it is as the source names them (Grasp keeps no names), their role, and how and when they
 * were interviewed; a click opens the interview.
 */
export const Interviewed = ({ people }: { people: Interviewee[] }) => (
  <div {...stylex.props(styles.people)}>
    {people.map((person) => (
      <Face key={person.sourceId} person={person} />
    ))}
  </div>
);

/**
 * The top of a note's page: the banner of the part it belongs to, as the part's own page shows it,
 * then the title and the summary with when the note was last heard of. On the banner sits who or
 * what the note is: a team's people interviewed, a tool's logo, a conversation's speaker, handed in
 * as `sticker`; a note with none shows the part's drawing.
 */
export const BannerHeader = ({
  note,
  kern,
  sticker,
}: {
  note: Note;
  kern: Kern;
  sticker?: ReactNode;
}) => {
  const group = groupOf[note.kind];
  // Only a conversation's own page shows who it was with; a team or a piece of work never shows its people.
  const shown = sticker;
  return (
    <header {...stylex.props(styles.header)}>
      <Panel group={group} short>
        {shown === undefined ? (
          <Drawing group={group} small />
        ) : (
          <div {...stylex.props(styles.sticker)}>{shown}</div>
        )}
      </Panel>
      <div {...stylex.props(styles.titles)}>
        <Heading level={1} size="lg">
          {note.kind === "statement"
            ? statementWords(note.id, note.title)
            : note.title}
        </Heading>
        {note.kind === "statement" && isTeamClaim(note.id) ? (
          <ClaimBasis />
        ) : null}
        {/* Last heard follows the summary's last word, so a summary that wraps keeps it beside its words. A source's summary already carries its date. */}
        <Text size="sm" tone="muted">
          {note.summary}
          {note.kind === "source" || kern.lastHeard === undefined ? null : (
            <>
              {" "}
              <LastHeard date={kern.lastHeard} />
            </>
          )}
        </Text>
      </div>
    </header>
  );
};

/** A statement as a line in a list: its words, and where and when it was said; both open it where it was said. */
export const StatementLine = ({
  row,
  showKind = false,
  onRemove,
}: {
  row: StatementRow;
  showKind?: boolean;
  /** Takes the statement out of the brain, for whoever may: a small button at its end. */
  onRemove?: ((statement: Statement) => void) | undefined;
}) => {
  const { t } = useLingui();
  const { statement, place, who } = row;
  const week = isoWeek(place.source.date);
  return (
    <li
      data-statement={statement.id}
      {...stylex.props(
        styles.line,
        onRemove !== undefined && styles.lineRemovable
      )}
    >
      <span {...stylex.props(styles.said)}>
        <Link
          hash={statement.id}
          params={{ noteId: place.source.id }}
          to="/brain/$noteId"
          {...stylex.props(styles.words, focus.words)}
        >
          {statement.text}
        </Link>
        {showKind ? (
          <span {...stylex.props(styles.kind)}>
            <KindLabel kind={statement.kind} />
          </span>
        ) : null}
        {isTeamClaim(statement.id) ? <ClaimBasis /> : null}
      </span>
      {/* Who said it as the company may read it, and the week: never a name, a day or the minute in the conversation. The source's title is its tooltip. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              hash={statement.id}
              params={{ noteId: place.source.id }}
              to="/brain/$noteId"
              {...stylex.props(styles.where, focus.words)}
            >
              {[who, t`week ${week}`].filter(given).join(" · ")}
            </Link>
          }
        />
        <TooltipContent>{place.source.title}</TooltipContent>
      </Tooltip>
      {onRemove === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            aria-label={t`Remove this from the brain`}
            icon={Trash}
            layout={styles.remove}
            onClick={() => {
              onRemove(statement);
            }}
            size="xs"
            variant="ghost"
          />
          <TooltipContent>{t`Remove from the brain`}</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
};

/** A heading over a part of the article, with how many it holds. */
export const PartHeading = ({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | string;
  children?: ReactNode;
}) => (
  <div {...stylex.props(styles.partHeading)}>
    <Heading level={2} size="ui-sm">
      {title}
      {count === undefined ? null : (
        <span {...stylex.props(styles.count)}>{count}</span>
      )}
    </Heading>
    {children}
  </div>
);

/** What a fold says on its trigger: its title, and how many it holds. */
const FoldTitle = ({ title, count }: { title: string; count?: number }) => (
  <>
    {title}
    {count === undefined ? null : (
      <span {...stylex.props(styles.count)}>{count}</span>
    )}
  </>
);

/** A folded part of the article, as the page folds its links: closed until asked for. */
export const Fold = ({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | undefined;
  children: ReactNode;
}) => (
  <Collapsible
    fit
    title={
      count === undefined ? (
        <FoldTitle title={title} />
      ) : (
        <FoldTitle count={count} title={title} />
      )
    }
  >
    <div {...stylex.props(styles.fold)}>{children}</div>
  </Collapsible>
);
