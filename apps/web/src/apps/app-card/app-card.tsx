import { DropdownMenuMore } from "@grasp-os/ui/components/dropdown-menu";
import type { DropdownMenuMoreItem } from "@grasp-os/ui/components/dropdown-menu";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import type { ReactNode } from "react";

import type { BackdropScene } from "../../chat/backdrop/look.ts";
import { cardMarker } from "./app-card.stylex.ts";
import { AppCardGround } from "./ground.tsx";
import type { AppCardGroundHue } from "./ground.tsx";
import { styles } from "./styles.ts";

// An App on the Apps page (apps-overview.tsx): a frame on a drawn ground of its own holds a
// window, cropped by the frame's foot so it reads as a peek into the App; under it the App's
// title (the link that opens it), a description of two lines at most, and where it stands. A "…"
// at the title's end opens the card's own actions. The window shows the App's mark and that there
// is no picture yet: core frames none of its own pages (`frame-ancestors 'none'`), and a running
// App per card was a whole second Grasp, so it stays quiet until core keeps a picture of each App.
//
// The card is one press (the title's link reaches over it) and one tab stop, with the "…" a
// second; the link's focus rings the frame.

/** One action in the card's "…" menu. */
export type AppCardAction = DropdownMenuMoreItem;

/** The words a heading of the card is written in, under the page's own heading. */
const Heading = ({ children }: { children: ReactNode }) => (
  <h3 {...stylex.props(styles.heading)}>{children}</h3>
);

/** The window in the frame: the App's mark over a quiet line, as no picture of it is kept. */
const QuietWindow = ({ mark }: { mark: ReactNode }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.window)}>
      <div {...stylex.props(styles.quiet)}>
        <span aria-hidden="true" {...stylex.props(styles.quietMark)}>
          {mark}
        </span>
        <p {...stylex.props(styles.quietWords)}>{t`No preview yet`}</p>
      </div>
    </div>
  );
};

/** An App on the Apps page: its frame and window, its title, what it is for and where it stands. */
export const AppCard = ({
  app,
  title,
  mark,
  description,
  meta,
  scene,
  hue,
  actions,
}: {
  /** The App's ID: the card opens it (/apps/$app). */
  app: string;
  /** The App's name: the card's title, and the link that opens it. */
  title: string;
  /** The App's mark, before its title and in its window. Decorative: the title names the App. */
  mark: ReactNode;
  /** What it is for, in its builder's words. Clamped to two lines. */
  description?: string;
  /** Where it stands, in one line. */
  meta: string;
  /** The scene its ground is drawn from, and the hue it is turned to (`appCardGroundOf`). */
  scene: BackdropScene;
  hue: AppCardGroundHue | undefined;
  /** The actions in the "…" menu. */
  actions: readonly AppCardAction[];
}) => {
  const { t } = useLingui();
  const id = useId();
  const described = description !== undefined && description !== "";
  const describedBy = described ? `${id}-description ${id}-meta` : `${id}-meta`;
  return (
    <article {...stylex.props(styles.card, cardMarker)}>
      <div {...stylex.props(styles.frame)}>
        <AppCardGround hue={hue} scene={scene} />
        <QuietWindow mark={mark} />
      </div>
      <div {...stylex.props(styles.words)}>
        <div {...stylex.props(styles.titleRow)}>
          <span aria-hidden="true" {...stylex.props(styles.mark)}>
            {mark}
          </span>
          <Heading>
            <Link
              aria-describedby={describedBy}
              data-card-link=""
              params={{ app }}
              title={title}
              to="/apps/$app"
              {...stylex.props(styles.link)}
            >
              {title}
            </Link>
          </Heading>
          <span {...stylex.props(styles.more)}>
            <DropdownMenuMore aria-label={t`More, ${title}`} items={actions} />
          </span>
        </div>
        {/* Always there, two lines high, so a card without a description keeps its row's lines. */}
        <p
          aria-hidden={described ? undefined : true}
          id={described ? `${id}-description` : undefined}
          title={described ? description : undefined}
          {...stylex.props(styles.description)}
        >
          {description}
        </p>
        <p id={`${id}-meta`} {...stylex.props(styles.meta)}>
          <span title={meta} {...stylex.props(styles.metaWords)}>
            {meta}
          </span>
        </p>
      </div>
    </article>
  );
};

/** The Apps page's grid: one to four cards a row, by the room it has; `empty` where it has none. */
export const AppCardGrid = ({
  children,
  empty,
}: {
  children: ReactNode[];
  empty: ReactNode;
}) => (
  <div {...stylex.props(styles.room)}>
    <div {...stylex.props(styles.grid)}>
      {children.length === 0 ? (
        <div {...stylex.props(styles.empty)}>{empty}</div>
      ) : (
        children
      )}
    </div>
  </div>
);
