import { Alert } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Icon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import {
  colors,
  duration,
  font,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MouseEvent, PointerEvent, ReactNode } from "react";

import { GraspLogo } from "../../connections/brand-logos.ts";
import { idleDoor, startDoor } from "./door.ts";
import type { Door } from "./door.ts";
import {
  lastUsedKey,
  noLastUsed,
  readLastUsed,
  watchLastUsed,
  writeLastUsed,
} from "./last-used.ts";

// Sign in: the website's login (joingrasp.com/login; grasplabs/website,
// login-sheet.astro and .css). The glass door over the whole page
// (door.ts), Grasp's mark at the top start, the title in the serif in the
// middle, the ways in under it as plain white buttons, and one quiet line
// at the foot. Night in both modes, as the website's. Every way in is a
// button that leaves for an identity provider and comes back. The way used
// last time in this browser comes first, ringed in mint, with a small
// "Last used" tag. While the pointer or the keyboard is on a way in, the
// green dims a little; chosen, the rest fades and the door opens at that
// way, then the page leaves (`onChoose`).
//
// The order of a press: `onPress` at once, then the door opens (Damsko's
// `duration.arrive`, at once under reduced motion), then the chosen way
// fades too, and the page goes (`onChoose`).

/** An identity provider the organisation has set up: its key, its name and its own mark. */
export interface SignInProvider {
  /** Its key, kept as "Last used" ("microsoft"). */
  id: string;
  /** Its name, as the button says it ("Microsoft"). */
  name: string;
  /** Its own mark, in its colours. */
  icon: IconData;
}

/** Why someone is back, said in one line over the ways in. */
export interface SignInNotice {
  /** Said plainly (no fault of the person's), or as a refusal. */
  plain: boolean;
  words: string;
}

const REDUCED = "(prefers-reduced-motion: reduce)";

// The sign-in page's own sizes and its veil: the website's, which no
// Damsko token holds.
/** The widest the title and the ways in run. */
const COLUMN = "26rem";
/** The width of a way in: 320px, as the website's. */
const WAYS = "20rem";
/** What dims the green while a way in is aimed at. */
const VEIL = "oklch(0.131 0.021 174.91 / 0.32)";

// The website's corner for a way in, and its ring 3px outside it.
const wayCorner = `min(${radius.base}, calc(${size.controlLg} / 2))`;
const ringGap = `calc(2 * ${size.ringWidth})`;

const styles = stylex.create({
  // The page: night in both modes, so what stands on it takes the dark scheme.
  page: {
    position: "relative",
    isolation: "isolate",
    overflow: "clip",
    boxSizing: "border-box",
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    width: "100%",
    minHeight: "100dvh",
    paddingBlock: `clamp(${space[5]}, 3vw, ${space[8]})`,
    paddingInline: `clamp(${space[5]}, 4vw, 3.5rem)`,
    colorScheme: "dark",
    color: colors.foreground,
    backgroundColor: colors.brandNight,
    textAlign: "center",
  },
  canvas: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    display: "block",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  },
  // While a way in is under the pointer or the keyboard, the green dims a little.
  veil: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    backgroundColor: VEIL,
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  veilOn: { opacity: 1 },
  top: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[4],
    textAlign: "start",
  },
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: space[2],
    // The website's mark beside its name: 21px, no Damsko icon size.
    [iconVars.size]: "21px",
    color: colors.foreground,
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
    fontSize: font.headingSm,
    lineHeight: font.headingSmLine,
    letterSpacing: font.trackingUiTitle,
  },
  // The middle, centred on the page: an unseen room over the title as tall
  // as why someone is back, the title, why someone is back, then the ways.
  // The two rooms open together, so the title keeps its place whether a
  // line stands under it or not, and only the ways move down to make room.
  middle: {
    display: "grid",
    alignContent: "center",
    justifyItems: "center",
    width: "100%",
    maxWidth: COLUMN,
    marginInline: "auto",
    paddingBlock: space[24],
  },
  head: {
    display: "grid",
    justifyItems: "center",
    gap: space[3],
    marginBlockEnd: space[10],
  },
  // A room that opens: one row, from none of its content's height to all of
  // it, its content cut while it is shorter.
  room: {
    display: "grid",
    gridTemplateRows: "0fr",
    width: "100%",
    transitionProperty: "grid-template-rows",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  roomOpen: { gridTemplateRows: "1fr" },
  roomInner: {
    display: "grid",
    justifyItems: "center",
    width: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  roomWords: {
    display: "grid",
    justifyItems: "center",
    width: "100%",
    paddingBlockEnd: space[5],
  },
  // The room over the title: the same line, unseen, so it is exactly as tall.
  mirror: { visibility: "hidden" },
  act: { display: "grid", justifyItems: "center", width: "100%" },
  // The ways in: the website's plain white, the secondary button in the light scheme.
  ways: {
    display: "grid",
    gap: space[3],
    width: "100%",
    maxWidth: WAYS,
    color: colors.foreground,
  },
  way: {
    position: "relative",
    display: "grid",
    colorScheme: "light",
    color: colors.foreground,
  },
  // The way used last time: a mint ring just outside the button's edge, so
  // the button keeps its size, and a small tag on its top edge.
  ring: {
    position: "absolute",
    inset: `calc(-1 * ${ringGap})`,
    pointerEvents: "none",
    borderRadius: `calc(${wayCorner} + ${ringGap})`,
    cornerShape: radius.shape,
    boxShadow: `0 0 0 ${size.ringWidth} ${colors.mint}`,
  },
  tag: {
    position: "absolute",
    top: 0,
    insetInlineEnd: space[4],
    display: "flex",
    transform: "translateY(-50%)",
    pointerEvents: "none",
  },
  notice: { width: "100%", maxWidth: WAYS, textAlign: "start" },
  foot: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: space[4],
  },
  // Leaving: everything but the chosen way fades as the door opens at it.
  fades: {
    transitionProperty: "opacity",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
  },
  gone: { opacity: 0 },
});

/** What this browser kept as "Last used", followed while the page stands. */
const useKeptLastUsed = () =>
  useSyncExternalStore(
    watchLastUsed,
    () => readLastUsed(lastUsedKey),
    noLastUsed
  );

/** The door on the page's canvas while it stands. */
const useDoor = () => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const door = useRef<Door | null>(null);
  useEffect(() => {
    const element = canvas.current;
    const started =
      element === null
        ? idleDoor
        : startDoor(element, matchMedia(REDUCED).matches);
    door.current = started;
    return () => {
      started.stop();
      door.current = null;
    };
  }, []);
  return { canvas, door };
};

interface Way extends SignInProvider {
  /** What its button says ("Continue with Microsoft"). */
  words: string;
}

/** The ways this page offers, Grasp staff's after the providers, the one used last time first. */
const useWays = (
  providers: readonly SignInProvider[],
  staff: boolean,
  last: string
): Way[] => {
  const { t } = useLingui();
  return [
    ...providers.map((given) => {
      const provider = given.name;
      return { ...given, words: t`Continue with ${provider}` };
    }),
    ...(staff
      ? [
          {
            id: "staff",
            name: "Grasp",
            icon: GraspLogo,
            words: t`Continue with Grasp staff`,
          },
        ]
      : []),
  ].toSorted((a, b) => Number(b.id === last) - Number(a.id === last));
};

interface WaysProps {
  ways: readonly Way[];
  /** A press is playing the way out: every way but the chosen one fades. */
  gone: boolean;
  /** The door has opened: the chosen way fades too, and the open door stands alone. */
  opened: boolean;
  last: string;
  leaving: string | undefined;
  choose: (id: string, event: MouseEvent<HTMLElement>) => void;
  aim: (on: boolean) => void;
}

/** The ways in, each a button to its provider; the one used last time first, ringed and tagged. */
const SignInWays = ({
  ways,
  gone,
  opened,
  last,
  leaving,
  choose,
  aim,
}: WaysProps) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.ways)}>
      {ways.map((way) => {
        const provider = way.name;
        return (
          <div
            key={way.id}
            data-way={way.id}
            data-mode="light"
            onPointerEnter={() => {
              aim(true);
            }}
            onPointerLeave={() => {
              aim(false);
            }}
            onFocus={() => {
              aim(true);
            }}
            onBlur={() => {
              aim(false);
            }}
            {...stylex.props(
              styles.way,
              styles.fades,
              gone && (opened || leaving !== way.id) && styles.gone
            )}
          >
            <Button
              disabled={leaving !== undefined && leaving !== way.id}
              errorLabel={t`Did not open`}
              loadingLabel={t`Opening ${provider}`}
              onClick={(event: MouseEvent<HTMLElement>) => {
                choose(way.id, event);
              }}
              size="lg"
              status={leaving === way.id ? "loading" : "idle"}
              successLabel={t`Opened`}
              // Never a second line: in a box narrower than a phone the
              // words end in an ellipsis.
              truncate
              variant="outline"
            >
              <Icon icon={way.icon} />
              {way.words}
            </Button>
            {way.id === last ? (
              <>
                <span aria-hidden="true" {...stylex.props(styles.ring)} />
                <span {...stylex.props(styles.tag)}>
                  <Badge size="sm" variant="success">
                    {t`Last used`}
                  </Badge>
                </span>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

interface NoticeRoomProps {
  /** Why someone is back now; none once it has gone. */
  notice: SignInNotice | undefined;
  /** The last line said, kept while its room closes. */
  said: SignInNotice | undefined;
  gone: boolean;
  /** The unseen copy over the title, only keeping room. */
  mirror?: boolean;
}

/**
 * A room for why someone is back, that opens to its line's height and
 * closes again. The one under the title holds the line; the one over it an
 * unseen copy, so the title stays put. A plain line is said politely, a
 * refusal at once.
 */
const NoticeRoom = ({
  notice,
  said,
  gone,
  mirror = false,
}: NoticeRoomProps) => {
  // The line itself, heard; a copy (over the title, or a line folding away) only keeps room.
  const live = !mirror && notice !== undefined;
  const line = live ? notice : said;
  const heard = line?.plain === true ? "polite" : "assertive";
  return (
    <div
      aria-hidden={live ? undefined : true}
      inert={!live}
      {...stylex.props(
        styles.room,
        notice !== undefined && styles.roomOpen,
        mirror && styles.mirror
      )}
    >
      <div {...stylex.props(styles.roomInner)}>
        {line === undefined ? null : (
          <div {...stylex.props(styles.roomWords)}>
            <div
              {...stylex.props(
                styles.notice,
                styles.fades,
                !mirror && gone && styles.gone
              )}
            >
              <Alert
                live={live ? heard : "off"}
                variant={line.plain ? "default" : "warning"}
              >
                {line.words}
              </Alert>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/** Every prop the sign-in page takes. */
export interface SignInProps {
  /** The providers the organisation has set up, in their order. "Last used" comes first. */
  providers: readonly SignInProvider[];
  /** Grasp staff's own way in, after the providers, with Grasp's mark. */
  staff: boolean;
  /** Why someone is back, said in one line over the ways in. */
  notice?: SignInNotice | undefined;
  /** The way being left for: it works, the others are out of use. */
  leaving?: string | undefined;
  /** A way in was pressed (`"staff"` for staff's way), before the door opens. */
  onPress: (id: string) => void;
  /** A way in was chosen and the door has opened. */
  onChoose: (id: string) => void;
  /** The line at the foot, and the language. */
  foot: ReactNode;
}

/** The sign-in page: the door behind, the title, the ways in, and why someone is back. */
export const SignIn = ({
  providers,
  staff,
  notice,
  leaving: leavingGiven,
  onPress,
  onChoose,
  foot,
}: SignInProps) => {
  const { t } = useLingui();
  const titleId = useId();
  const kept = useKeptLastUsed();
  const { canvas, door } = useDoor();
  // A press leaves for the provider: that button works while the door opens, the rest fades.
  const [pressed, setPressed] = useState<string>();
  // The door has opened at the chosen way: that way fades too, and the page leaves.
  const [opened, setOpened] = useState(false);
  const [aimed, setAimed] = useState(false);
  const leaving = pressed ?? leavingGiven;
  // A kept provider that is no longer offered is no "Last used".
  const last = providers.some((provider) => provider.id === kept) ? kept : "";
  const ways = useWays(providers, staff, last);
  // Only a press plays the way out; `leaving` from the page shows the state, everything still there.
  const gone = pressed !== undefined;
  // Why someone is back, kept after it goes, so its room closes with its words in it.
  const [said, setSaid] = useState<SignInNotice | undefined>(notice);
  if (notice !== undefined && notice !== said) {
    setSaid(notice);
  }
  const choose = (id: string, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    if (leaving !== undefined) {
      return;
    }
    setPressed(id);
    setAimed(false);
    onPress(id);
    if (id !== "staff") {
      writeLastUsed(lastUsedKey, id);
    }
    const done = () => {
      setOpened(true);
      onChoose(id);
    };
    if (door.current === null) {
      done();
      return;
    }
    door.current.leave(event.currentTarget.getBoundingClientRect(), done);
  };
  const point = (event: PointerEvent<HTMLElement>, on: boolean) => {
    const box = event.currentTarget.getBoundingClientRect();
    door.current?.pointer(
      event.clientX - box.left,
      event.clientY - box.top,
      on
    );
  };
  return (
    <section
      aria-labelledby={titleId}
      data-mode="dark"
      onPointerDown={(event) => {
        point(event, true);
      }}
      onPointerLeave={(event) => {
        point(event, false);
      }}
      onPointerMove={(event) => {
        point(event, true);
      }}
      {...stylex.props(styles.page)}
    >
      <canvas
        aria-hidden="true"
        ref={canvas}
        {...stylex.props(styles.canvas)}
      />
      <span
        aria-hidden="true"
        {...stylex.props(styles.veil, aimed && styles.veilOn)}
      />
      <div {...stylex.props(styles.top, styles.fades, gone && styles.gone)}>
        <span {...stylex.props(styles.brand)}>
          <Icon icon={GraspLogo} />
          Grasp
        </span>
      </div>
      <div {...stylex.props(styles.middle)}>
        <NoticeRoom gone={gone} mirror notice={notice} said={said} />
        <div {...stylex.props(styles.head, styles.fades, gone && styles.gone)}>
          <Heading id={titleId} level={1} size="xl">
            {t`Log in`}
          </Heading>
        </div>
        <NoticeRoom gone={gone} notice={notice} said={said} />
        <div {...stylex.props(styles.act)}>
          <SignInWays
            aim={setAimed}
            choose={choose}
            gone={gone}
            last={last}
            leaving={leaving}
            opened={opened}
            ways={ways}
          />
        </div>
      </div>
      <div {...stylex.props(styles.foot, styles.fades, gone && styles.gone)}>
        {foot}
      </div>
    </section>
  );
};
