// AppCard: an app on the Apps page. A frame on a quiet grainy ground holds a window with a sharp
// screenshot of the app (or, as `kind: "live"`, the app running, laid out at a desktop's width
// and scaled down to fit), cropped by the frame's foot so it reads as a peek into the real app;
// under it the app's title (the link that opens it), a description of two lines at most, and its
// owner with when it last changed. A "…" button at the title's end opens the card's own actions.
// Grasp's own: Palermo has no such part.
//
//   <AppCard title="Tickets" href="/apps/tickets"
//     preview={{ src: "/shots/tickets.webp", srcDark: "/shots/tickets-dark.webp", srcNarrow: "/shots/tickets-narrow.webp",
//       srcNarrowDark: "/shots/tickets-narrow-dark.webp", alt: "The Tickets overview" }}
//     owner={{ name: "Sanne de Wit", picture: "/people/sanne.jpg" }} meta="Edited 9 days ago" />
//   <AppCardGrid>{apps.map((app) => <AppCard key={app.id} {...app} />)}</AppCardGrid>
//
// The app is a picture of itself, never used here; it runs when it is opened. The screenshot is
// inert, lazy, decoded off the main thread and not draggable; a running app's frame is inert,
// hidden from screen readers, out of the tab order, sandboxed to scripts alone and loaded lazily.
// The card is one press (the title's link reaches over it) and one tab stop, with the "…" a
// second; the link's focus rings the frame. Every value is a token (src/tokens); a caller may set
// layout only (`layout`).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import { useId } from "react";
import type { ReactNode } from "react";

import { Avatar, AvatarImage, AvatarFallback } from "../avatar";
import type { LayoutStyle } from "../layout/layout";
import { useWords, withGiven } from "../words/words";
import { cardMarker } from "./app-card.stylex";
import type { AppCardLabels } from "./labels";
import { MoreMenu, Window } from "./parts";
import type { AppCardAction, AppCardPreview } from "./parts";
import { styles } from "./styles";
import { englishLabels } from "./words";

/** What a caller may style: its size and where it sits. Never its look. */
export type AppCardLayoutStyle = LayoutStyle;

/** The ground the frame stands on: four quiet tones. */
export type AppCardTone = "sea" | "sand" | "moss" | "dusk";

/** Where the app stands: running, first being built, or failed to start. */
export type AppCardState = "ready" | "building" | "failed";

/** Who owns the app: a person, and the team it is for. */
export interface AppCardOwner {
  /** The owner's name. It names the avatar, and is the line's words unless `team` is given. */
  name: string;
  /** The owner's picture. Until it loads, and without it, their initials. */
  picture?: string;
  /** Who the app is for, in the caller's words ("For Finance"): the line's words in place of the name. */
  team?: string;
}

/** Every prop an AppCard takes. */
export interface AppCardProps {
  /** The app's name: the card's title, and the link that opens it. */
  title: string;
  /** Where the card goes: the app. Leave it out when `render` is a router's link that carries it. */
  href?: string;
  /**
   * The card's link drawn as a router's own (`render={<Link to="/apps/tickets" />}`): it takes the
   * link's look, words and wiring, and keeps its own props. Without it, an `<a href>`.
   */
  render?: RenderProp;
  /** One or two sentences on what the app is for. Clamped to two lines. */
  description?: string;
  /**
   * What the window shows: a screenshot of the app (`{ src, alt, srcDark?, srcNarrow?, srcNarrowDark? }`, the default kind), the
   * app running (`{ kind: "live", src, sandbox? }`), a picture of it (any node, laid out at a
   * desktop's width), or nothing for a quiet window.
   */
  preview?: AppCardPreview | ReactNode;
  /** Who owns the app: their avatar starts the meta line. */
  owner?: AppCardOwner;
  /** The meta line after the owner, in the caller's words ("Edited 9 days ago"). */
  meta?: string;
  /**
   * The ground the frame stands on.
   * @default "sea"
   */
  tone?: AppCardTone;
  /** The actions in the "…" menu. Without them there is no "…". */
  actions?: readonly AppCardAction[];
  /**
   * Where the app stands: `building` draws App building in the window and says so in the meta
   * line; `failed` a quiet window, and says so too.
   * @default "ready"
   */
  status?: AppCardState;
  /** @deprecated Use `status`. */
  state?: AppCardState;
  /**
   * The title's heading level, under the page's own heading.
   * @default 3
   */
  headingLevel?: 2 | 3 | 4;
  /** @deprecated Use `headingLevel`. */
  level?: 2 | 3 | 4;
  /** The card's own words. Any left out are English. */
  labels?: Partial<AppCardLabels>;
  /** Its size and where it sits. */
  layout?: AppCardLayoutStyle;
}

interface MetaProps {
  id: string;
  owner: AppCardOwner | undefined;
  words: string | undefined;
}

/** The meta line: the owner's avatar and words, then the meta, on one line with an ellipsis. */
const Meta = ({ id, owner, words }: MetaProps) => {
  const who = owner === undefined ? undefined : (owner.team ?? owner.name);
  const line = [who, words]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
  if (line === "") {
    return null;
  }
  // The avatar is said by its name only when the line says the team in its place.
  const said =
    owner !== undefined && owner.team !== undefined && owner.team !== "";
  return (
    <p id={id} {...stylex.props(styles.meta)} data-slot="app-card-meta">
      {owner === undefined ? null : (
        <Avatar name={owner.name} size="xs" decorative={!said}>
          <AvatarImage src={owner.picture} />
          <AvatarFallback />
        </Avatar>
      )}
      <span title={line} {...stylex.props(styles.metaWords)}>
        {line}
      </span>
    </p>
  );
};

/** The words a heading of `level` is written in. */
const Heading = ({
  level,
  children,
}: {
  level: 2 | 3 | 4;
  children: ReactNode;
}) => {
  if (level === 2) {
    return <h2 {...stylex.props(styles.heading)}>{children}</h2>;
  }
  if (level === 4) {
    return <h4 {...stylex.props(styles.heading)}>{children}</h4>;
  }
  return <h3 {...stylex.props(styles.heading)}>{children}</h3>;
};

/** The meta line's words in each state: the caller's meta, or what is the case with the app. */
const metaOf = (
  state: AppCardState,
  meta: string | undefined,
  words: AppCardLabels
) => {
  if (state === "building") {
    return words.building;
  }
  if (state === "failed") {
    return words.failed;
  }
  return meta;
};

export const AppCard = ({
  title,
  href,
  render,
  description,
  preview,
  owner,
  meta,
  tone = "sea",
  actions,
  state: stateDeprecated,
  status: state = stateDeprecated ?? "ready",
  level: levelDeprecated,
  headingLevel: level = levelDeprecated ?? 3,
  labels,
  layout,
}: AppCardProps) => {
  const id = useId();
  const words = withGiven(useWords("appCard", englishLabels), labels ?? {});
  const described = description !== undefined && description !== "";
  const metaWords = metaOf(state, meta, words);
  const hasMeta =
    owner !== undefined || (metaWords !== undefined && metaWords !== "");
  const describedBy = [
    described ? `${id}-description` : "",
    hasMeta ? `${id}-meta` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  return (
    <article
      data-slot="app-card"
      data-state={state}
      data-tone={tone}
      {...stylex.props(styles.card, cardMarker, layout)}
    >
      <div
        id={`${id}-frame`}
        data-slot="app-card-frame"
        {...stylex.props(styles.frame, styles[tone])}
      >
        <span aria-hidden="true" {...stylex.props(styles.grain)} />
        <Window
          preview={preview}
          title={title}
          building={state === "building"}
          failed={state === "failed"}
          buildingLabel={words.building}
          failedLabel={words.failed}
          emptyLabel={words.empty}
        />
      </div>
      <div {...stylex.props(styles.words)}>
        <div {...stylex.props(styles.titleRow)}>
          <Heading level={level}>
            {renderElement(
              "a",
              {
                href,
                title,
                "data-slot": "app-card-link",
                "data-card-link": "",
                // The part that shows this link's focus: the frame (scripts/check-focus-ring.ts reads it).
                "data-ring-on": `${id}-frame`,
                "aria-describedby":
                  describedBy === "" ? undefined : describedBy,
                className: stylex.props(styles.link).className,
                children: title,
              },
              render
            )}
          </Heading>
          {actions === undefined || actions.length === 0 ? null : (
            <MoreMenu actions={actions} label={`${words.more}, ${title}`} />
          )}
        </div>
        {/* Always there, two lines high, so a card without a description keeps its row's lines. */}
        <p
          id={described ? `${id}-description` : undefined}
          title={described ? description : undefined}
          aria-hidden={described ? undefined : true}
          {...stylex.props(styles.description)}
          data-slot="app-card-description"
        >
          {description}
        </p>
        <Meta id={`${id}-meta`} owner={owner} words={metaWords} />
      </div>
    </article>
  );
};

/** Every prop an AppCardGrid takes. */
export interface AppCardGridProps {
  /** The cards. */
  children: ReactNode;
  /** Its size and where it sits. */
  layout?: AppCardLayoutStyle;
}

// One card a row in a room under 40rem (a phone, a narrow panel), two from 40rem (the Apps page
// beside a sidebar: each frame wide enough to read the app), three from 96rem (a wide screen,
// where two would make each frame taller than the window). The room, not the window, decides.
/** The Apps page's grid: one, two or three cards a row, by the room it has. */
export const AppCardGrid = ({ children, layout }: AppCardGridProps) => (
  <div data-slot="app-card-grid" {...stylex.props(styles.room, layout)}>
    <div {...stylex.props(styles.grid)}>{children}</div>
  </div>
);
