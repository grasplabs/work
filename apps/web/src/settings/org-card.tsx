import type { Organization } from "@grasp-os/shared/organization";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { formatList } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { ImageWell } from "../grasp/file-upload/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { Edit, Globe, Icon, Mail } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { simply } from "../grasp/motion/simply.stylex.ts";
import { PanelTexture } from "../grasp/panel/texture.tsx";
import { RowProblem } from "../grasp/setting-row/line-context.ts";
import { Skeleton } from "../grasp/skeleton/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useOrganizationLogo, useOrganizationName } from "./workspace-name.tsx";

// The organization's card, at the head of Settings › Workspace: the
// library's Organisation card pattern (grasplabs/ui,
// examples/patterns/org-card.tsx), on what core keeps. A cover across the
// top in the library's own dither (PanelTexture); the logo stands over the
// cover's lower edge, the name beside it in the serif with Edit after it,
// and the facts the deployment decides in one line of small tags.
//
// The logo is the well itself: a press or a dropped picture saves it
// (workspace-name.tsx). The name is edited in place: Edit opens a field,
// Enter or leaving it keeps the new name, Escape keeps the old. What went
// wrong, with the logo or the name, is said in one line under the name.
// Nothing on the card changes size between states. Someone who is not one
// of the organization's admins sees it all, and changes nothing.

const NARROW = "@media (width < 30rem)";

const COVER = { wide: 112, phone: 88 };

const styles = stylex.create({
  card: {
    display: "grid",
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: `${grasp.edge}, ${grasp.liftLow}`,
  },
  cover: {
    position: "relative",
    overflow: "hidden",
    height: { default: COVER.wide, [NARROW]: COVER.phone },
    backgroundColor: grasp.soft,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  // On a wide card the texture's box runs on past the card's end, so its
  // light reaches across the whole cover. A phone's cover is short enough.
  reach: { insetInlineEnd: { default: "-60%", [NARROW]: 0 } },
  body: {
    display: "grid",
    gap: grasp.space4,
    paddingInline: { default: grasp.space6, [NARROW]: grasp.space4 },
    paddingBlockEnd: grasp.space6,
  },
  who: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "end",
    columnGap: grasp.space4,
  },
  // The name and, under it, what went wrong when something did: the line's
  // row opens from nothing, so the name rises to make room for it.
  words: {
    display: "grid",
    gridTemplateRows: "auto 0fr",
    minWidth: 0,
    transitionProperty: {
      default: "grid-template-rows",
      [media.reduced]: "none",
    },
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  wordsOpen: { gridTemplateRows: "auto 1fr" },
  lineRoom: { minHeight: 0, overflow: "hidden" },
  problem: {
    margin: 0,
    color: grasp.danger,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  // A grid, so the well sits on no text line and the card is as tall with a logo as without.
  picture: {
    position: "relative",
    display: "grid",
    marginBlockStart: {
      default: `calc(-1 * ${grasp.space12})`,
      [NARROW]: `calc(-1 * ${grasp.space10})`,
    },
    padding: grasp.space1,
    borderRadius: `calc(${grasp.corner} + ${grasp.space1})`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
  },
  nameLine: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minHeight: grasp.controlMd,
    minWidth: 0,
  },
  // The name's type: the serif at the title's size. The name and its field
  // both wear it, so the words do not change when editing starts.
  type: {
    color: grasp.ink,
    fontFamily: grasp.fontSerif,
    fontSize: { default: grasp.titleMd, [NARROW]: grasp.titleSm },
    lineHeight: { default: grasp.titleMdLine, [NARROW]: grasp.titleSmLine },
    fontWeight: grasp.weightRegular,
  },
  // A long name wraps under itself rather than lose its end, on a phone too.
  name: {
    margin: 0,
    minWidth: 0,
    overflowWrap: "break-word",
    textWrap: "balance",
  },
  // The field in place: a box round the words as wide as they are, its edge
  // a step out from them, so nothing moves when it opens or closes. A hidden
  // copy of the words and the input share one grid cell.
  field: {
    display: "inline-grid",
    gridTemplateColumns: "minmax(0, auto)",
    flexShrink: 1,
    minWidth: `calc(${grasp.space12} * 3)`,
    maxWidth: `calc(100% + 2 * ${grasp.space2})`,
    marginInline: `calc(-1 * ${grasp.space2})`,
    marginBlock: `calc(-1 * ${grasp.space1})`,
    paddingInline: grasp.space2,
    paddingBlock: grasp.space1,
    boxSizing: "border-box",
    borderRadius: grasp.cornerMark,
    backgroundColor: grasp.raised,
    boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.line}`,
  },
  stack: { gridArea: "1 / 1" },
  sizer: { visibility: "hidden", whiteSpace: "pre", overflow: "hidden" },
  input: {
    minWidth: 0,
    width: "100%",
    height: { default: grasp.titleMdLine, [NARROW]: grasp.titleSmLine },
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    outlineStyle: "none",
  },
  // While the name is edited the pencil keeps its room, unseen and inert, so the line does not move.
  away: { opacity: 0 },
  tags: {
    display: "flex",
    flexWrap: "wrap",
    gap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  tag: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    minHeight: grasp.controlXs,
    paddingInline: grasp.space2,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.soft,
    color: grasp.ink,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  tagIcon: { display: "inline-flex", color: grasp.muted },
});

// The card waiting (Workspace's pending page): words as quiet lines, the
// well and each fact as their own empty frames, so the card is as tall
// loading as loaded and the card under it never drops.
const waits = stylex.create({
  // The well's own empty frame: its size (96px), its corner and its edge.
  well: {
    boxSizing: "border-box",
    width: grasp.space24,
    height: grasp.space24,
    borderRadius: `min(${grasp.corner}, 28%)`,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.edge,
  },
  // The name's line at the title's height (the serif's, smaller on a phone).
  name: {
    width: "10rem",
    maxWidth: "100%",
    height: { default: grasp.titleMdLine, [NARROW]: grasp.titleSmLine },
  },
  // The pencil's room, kept for an admin: a small button's square.
  pencil: { flexShrink: 0, width: grasp.controlSm, height: grasp.controlSm },
  // A fact's own empty pill, at a short fact's width.
  tag: { width: "8rem" },
});

/**
 * The organization's card before it is read: the cover stands, the well
 * and the two facts wait as empty frames, the name as a quiet line, the
 * pencil's room kept for an admin.
 */
export const OrgCardLoading = ({ canChange }: { canChange: boolean }) => {
  const { t } = useLingui();
  return (
    <section
      aria-busy="true"
      aria-label={t`Organization`}
      {...stylex.props(styles.card)}
    >
      <div aria-hidden="true" {...stylex.props(styles.cover)}>
        <PanelTexture layout={styles.reach} />
      </div>
      <div aria-hidden="true" {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.who)}>
          <div {...stylex.props(styles.picture)}>
            <span {...stylex.props(waits.well)} />
          </div>
          <div {...stylex.props(styles.words)}>
            <div {...stylex.props(styles.nameLine)}>
              <Skeleton layout={waits.name} />
              {canChange ? <span {...stylex.props(waits.pencil)} /> : null}
            </div>
          </div>
        </div>
        <ul {...stylex.props(styles.tags)}>
          <li {...stylex.props(styles.tag, waits.tag)} />
          <li {...stylex.props(styles.tag, waits.tag)} />
        </ul>
      </div>
    </section>
  );
};

/** One fact the deployment decides, as a small tag with its icon. */
const Fact = ({ icon, children }: { icon: IconData; children: ReactNode }) => (
  <li {...stylex.props(styles.tag)}>
    <span aria-hidden="true" {...stylex.props(styles.tagIcon)}>
      <Icon icon={icon} />
    </span>
    <span dir="auto">{children}</span>
  </li>
);

/** The name, in the serif; for an admin, edited in place from the pencil after it. */
const Name = ({
  name,
  canChange,
  onRename,
}: {
  name: string;
  canChange: boolean;
  onRename: (name: string) => void;
}) => {
  const { t } = useLingui();
  const [draft, setDraft] = useState(name);
  const [editing, setEditing] = useState(false);
  const edit = useRef<HTMLButtonElement | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  // Enter closes the field and the field then loses the cursor: one of the two keeps the name, never both.
  const open = useRef(false);
  useEffect(() => {
    if (editing) {
      field.current?.focus();
    }
  }, [editing]);
  const done = (keep: boolean): void => {
    if (!open.current) {
      return;
    }
    open.current = false;
    const next = draft.trim();
    if (keep && next !== "") {
      onRename(next);
    } else {
      setDraft(name);
    }
    setEditing(false);
    requestAnimationFrame(() => edit.current?.focus());
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      done(true);
    } else if (event.key === "Escape") {
      done(false);
    }
  };
  return (
    <div {...stylex.props(styles.nameLine)}>
      {editing ? (
        <span {...stylex.props(styles.field, focus.fieldWithin)}>
          <span
            aria-hidden="true"
            {...stylex.props(styles.stack, styles.type, styles.sizer)}
          >
            {draft === "" ? name : draft}
          </span>
          <input
            aria-label={t`Name`}
            dir="auto"
            maxLength={80}
            onBlur={() => {
              done(true);
            }}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={keys}
            ref={field}
            // One character wide by itself: the hidden copy of the words sets the field's width.
            size={1}
            value={draft}
            {...stylex.props(styles.stack, styles.type, styles.input)}
          />
        </span>
      ) : (
        <h2 {...stylex.props(styles.type, styles.name)}>{name}</h2>
      )}
      {canChange ? (
        <span inert={editing} {...stylex.props(editing && styles.away)}>
          <Button
            aria-label={t`Edit the name`}
            icon={Edit}
            onClick={() => {
              setDraft(name);
              open.current = true;
              setEditing(true);
            }}
            ref={edit}
            size="sm"
            variant="ghost"
          />
        </span>
      ) : null}
    </div>
  );
};

/** The organization's card: its cover, its logo, its name and the facts the deployment decides. */
export const OrgCard = ({
  organization,
  canChange,
}: {
  organization: Organization;
  canChange: boolean;
}) => {
  const { t } = useLingui();
  const naming = useOrganizationName(organization.name);
  const handleRename = naming.rename;
  const logo = useOrganizationLogo(organization.logo);
  // What the well says of a logo it refused or could not save, for the line under the name.
  const [logoProblem, setLogoProblem] = useState("");
  const problem = logoProblem === "" ? (naming.refused ?? "") : logoProblem;
  const problemId = useId();
  // The line's words stay while it closes, so it folds away whole; a screen
  // reader hears only the current problem, from the hidden status beside it.
  const [lastProblem, setLastProblem] = useState("");
  if (problem !== "" && problem !== lastProblem) {
    setLastProblem(problem);
  }
  const domains = formatList(
    organization.signInDomains.map((domain) => `@${domain}`)
  );
  return (
    <section aria-label={t`Organization`} {...stylex.props(styles.card)}>
      <div aria-hidden="true" {...stylex.props(styles.cover)}>
        <PanelTexture layout={styles.reach} />
      </div>
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.who)}>
          <div {...stylex.props(styles.picture)}>
            <RowProblem value={setLogoProblem}>
              <ImageWell
                {...logo}
                aria-label={t`Logo`}
                disabled={!canChange}
                fit="contain"
                initials={naming.name}
                size="lg"
                {...(problem === "" ? {} : { "aria-describedby": problemId })}
              />
            </RowProblem>
          </div>
          <div
            {...stylex.props(styles.words, problem !== "" && styles.wordsOpen)}
          >
            <Name
              canChange={canChange}
              name={naming.name}
              onRename={handleRename}
            />
            <div {...stylex.props(styles.lineRoom)}>
              <p aria-hidden="true" {...stylex.props(styles.problem)}>
                <bdi>{lastProblem}</bdi>
              </p>
            </div>
            <output id={problemId} {...stylex.props(visuallyHidden)}>
              {problem}
            </output>
          </div>
        </div>
        <ul aria-label={t`About`} {...stylex.props(styles.tags)}>
          {/* With the @ an address has, so a domain reads as where people sign in from. */}
          {domains === "" ? null : <Fact icon={Mail}>{domains}</Fact>}
          <Fact icon={Globe}>{t`European Union`}</Fact>
        </ul>
      </div>
    </section>
  );
};
