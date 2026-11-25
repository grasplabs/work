import type { Statement } from "@grasp-os/shared/brain";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Icon, TrashIcon } from "@grasp-os/ui/lib/icons";
import { focusRingText } from "@grasp-os/ui/lib/styles";
import {
  colors,
  font,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { formatDay, isoWeek } from "../../format.ts";
import { ClaimBasis } from "../aggregate.tsx";
import type { Kern, StatementRow } from "../article-kern.ts";
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
    gap: space["2"],
    marginInlineStart: space["2"],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.success,
    whiteSpace: "nowrap",
  },
  heardDot: {
    width: size.severityDot,
    height: size.severityDot,
    borderRadius: radius.circle,
    backgroundColor: colors.success,
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: space["4"],
  },
  sticker: {
    position: "absolute",
    insetBlockEnd: space["4"],
    insetInlineStart: space["5"],
  },
  titles: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["1"],
    minWidth: 0,
  },
  line: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "baseline",
    gap: space["4"],
    paddingBlock: space["3"],
    borderTopWidth: { default: size.hairline, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.bodyForeground,
  },
  lineRemovable: {
    gridTemplateColumns: "minmax(0, 1fr) auto auto",
  },
  said: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["1"],
    minWidth: 0,
  },
  words: {
    color: "inherit",
    textDecorationLine: { default: "none", ":hover": "underline" },
  },
  kind: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  where: {
    maxWidth: `calc(4 * ${space["16"]})`,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "end",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    textDecorationLine: { default: "none", ":hover": "underline" },
  },
  remove: { alignSelf: "center" },
  partHeading: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  count: {
    marginInlineStart: space["2"],
    fontWeight: font.weightNormal,
    color: colors.mutedForeground,
  },
  fold: {
    display: "flex",
    flexDirection: "column",
    gap: space["5"],
    paddingTop: space["2"],
    paddingBottom: space["4"],
  },
});

/** When the team was last heard: the date of the newest conversation, so the reader knows how fresh it is. */
const LastHeard = ({ date }: { date: string }) => {
  const day = formatDay(date);
  return (
    <span {...stylex.props(styles.lastHeard)}>
      <span aria-hidden="true" {...stylex.props(styles.heardDot)} />
      <Trans>Last heard {day}</Trans>
    </span>
  );
};

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
          <ClaimBasis statementId={note.id} />
        ) : null}
        {/* Last heard follows the summary's last word, so a summary that wraps keeps it beside its words. A source's summary already carries its date. */}
        <Text size="sm" color="muted">
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
          {...stylex.props(styles.words, focusRingText)}
        >
          {statement.text}
        </Link>
        {showKind ? (
          <span {...stylex.props(styles.kind)}>
            <KindLabel kind={statement.kind} />
          </span>
        ) : null}
        {isTeamClaim(statement.id) ? (
          <ClaimBasis statementId={statement.id} />
        ) : null}
      </span>
      {/* Who said it as the company may read it, and the week: never a name, a day or the minute in the conversation. The source's title is its tooltip. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            hash={statement.id}
            params={{ noteId: place.source.id }}
            to="/brain/$noteId"
            {...stylex.props(styles.where, focusRingText)}
          >
            {[who, t`week ${week}`].filter(given).join(" · ")}
          </Link>
        </TooltipTrigger>
        <TooltipContent>{place.source.title}</TooltipContent>
      </Tooltip>
      {onRemove === undefined ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={t`Remove this from the brain`}
              onClick={() => {
                onRemove(statement);
              }}
              size="icon-xs"
              style={styles.remove}
              variant="ghost"
            >
              <Icon icon={TrashIcon} />
            </Button>
          </TooltipTrigger>
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
    <Heading level={2} size="2xs">
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
  <Collapsible fitContent>
    <CollapsibleTrigger>
      {count === undefined ? (
        <FoldTitle title={title} />
      ) : (
        <FoldTitle count={count} title={title} />
      )}
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div {...stylex.props(styles.fold)}>{children}</div>
    </CollapsibleContent>
  </Collapsible>
);
