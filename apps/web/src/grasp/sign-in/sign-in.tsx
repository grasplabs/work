// Sign in: the website's login (joingrasp.com/login; grasplabs/website, login-sheet.astro and .css),
// copied into the library. The glass door over the whole page (door.ts), Grasp's mark at the top
// start and one quiet link at the top end, the title in the serif in the middle, the ways in under
// it as plain white buttons, and one quiet line at the foot. Night in both themes, as the website's.
// Every way in is a button that leaves for an identity provider and comes back: no email field, no
// code, no password. The way used last time in this browser comes first, ringed in mint, with a
// small "Last used" tag. While the pointer or the keyboard is on a way in, the green dims a little;
// chosen, the rest fades and the door opens at that way, then the page leaves (`onChoose`).
//
//   <SignIn providers={[{ id: "microsoft", name: "Microsoft", icon: BrandMicrosoft }]} onChoose={go} />
//   <SignIn providers={providers} staff notice="ended" />       sent back: one line over the buttons
//   <SignIn providers={[]} page="staff" />                      the staff page
//
// Parts: Button (quiet, in the light scheme: the website's plain white), Alert, Text, Link, Icon and
// the brands' own marks. Every word is the catalogue's `signIn` (words.ts), and the `words` prop
// replaces any of them. Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MouseEvent, PointerEvent, ReactNode } from "react";

import { Alert } from "../alert/alert";
import { Badge } from "../badge/badge";
import { Button } from "../button/button";
import { Heading } from "../heading/heading";
import { ArrowRight, BrandGrasp, Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { Link } from "../link/link";
import { Text } from "../text/text";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import { idleDoor, startDoor } from "./door";
import type { Door } from "./door";
import {
  lastUsedKey,
  noLastUsed,
  readLastUsed,
  watchLastUsed,
  writeLastUsed,
} from "./last-used";
import { signInWords } from "./words";
import type { SignInNoticeWords, SignInWords } from "./words";

type Layout = string | number | null;

/** What a caller may style: where the page sits and how big it is. */
export type SignInLayoutStyle = stylex.StyleXStyles<{
  width?: Layout;
  minWidth?: Layout;
  maxWidth?: Layout;
  height?: Layout;
  minHeight?: Layout;
  maxHeight?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginInline?: Layout;
  flexGrow?: Layout;
  alignSelf?: Layout;
  gridArea?: Layout;
}>;

/** An identity provider the organisation has set up: its key, its name and its own mark. */
export interface SignInProvider {
  /** Its key, kept as "Last used" ("microsoft"). */
  id: string;
  /** Its name, as the button says it ("Microsoft"). */
  name: string;
  /** Its own mark, in its colours (BrandMicrosoft, BrandGoogle). */
  icon: IconData;
  /** Where the way goes once the door has opened, unless `onSelect` or the page's `onChoose` takes it. */
  href?: string;
  /** Called once the door has opened, in place of going to `href`. */
  onSelect?: () => void;
}

/** Why someone is back: a line of the catalogue's, or the product's own in a tone. */
export type SignInNotice =
  | keyof SignInNoticeWords
  | { tone: "plain" | "refusal"; words: string };

/** Any of the page's words, for this page only. */
export type SignInWordsGiven = Partial<Omit<SignInWords, "notices">> & {
  notices?: Partial<SignInNoticeWords>;
};

/** Every prop Sign in takes. */
export interface SignInProps {
  /** The providers the organisation has set up, in their order. "Last used" comes first. */
  providers: readonly SignInProvider[];
  /**
   * Grasp staff's own way in, after the providers, with Grasp's mark.
   * @default false
   */
  staff?: boolean;
  /**
   * Which page: the sign-in page, the staff page (staff's way only) or the guest page (no way in:
   * `children` in its place).
   * @default "sign-in"
   */
  page?: "sign-in" | "staff" | "guest";
  /** Why someone is back, said in one line over the buttons. `"offline"` puts every way out of use. */
  notice?: SignInNotice;
  /** The way being left for, as a press makes it: it works, the others are out of use. */
  leaving?: string;
  /** The way used last time, in place of what this browser kept. */
  lastUsed?: string;
  /**
   * The key "Last used" is kept under in this browser.
   * @default "grasp-sign-in-last"
   */
  rememberKey?: string;
  /**
   * A way in was chosen and the door has opened (`"staff"` for staff's way), for a way with no
   * `onSelect` of its own. Without either, the page goes to the way's `href`.
   */
  onChoose?: (id: string) => void;
  /** Where staff's way goes once the door has opened. */
  staffHref?: string;
  /** The organisation's own name or logo, over the title. */
  organisation?: ReactNode;
  /** The language switch, at the foot. */
  language?: ReactNode;
  /** Where the quiet link at the top end goes; none without it. */
  backHref?: string;
  /** Where the foot line's link goes; no foot line without it. */
  footHref?: string;
  /** The guest page's content, in place of the ways in. */
  children?: ReactNode;
  /** Any of the page's words, over the catalogue's. */
  words?: SignInWordsGiven;
  /**
   * The door stands still, as with reduced motion: one picture, and a chosen way leaves at once.
   * @default false
   */
  still?: boolean;
  /**
   * No door: the page's night alone, as where WebGL cannot draw.
   * @default false
   */
  plain?: boolean;
  /** Layout only: where the page sits and how big it is. */
  layout?: SignInLayoutStyle;
}

const plainNotices = new Set<string>(["ended", "soon", "offline"]);

const REDUCED = "(prefers-reduced-motion: reduce)";

// The website's corner for a way in, and its ring 3px outside it.
const wayCorner = `min(${grasp.corner}, calc(${grasp.controlLg} / 2))`;
const ringGap = `calc(2 * ${grasp.ringWidth})`;

const styles = stylex.create({
  // The page: night in both themes, so what stands on it takes the dark scheme.
  page: {
    position: "relative",
    isolation: "isolate",
    overflow: "clip",
    boxSizing: "border-box",
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    width: "100%",
    minHeight: "100dvh",
    paddingBlock: `clamp(${grasp.space5}, 3vw, ${grasp.space8})`,
    paddingInline: `clamp(${grasp.space5}, 4vw, 3.5rem)`,
    colorScheme: "dark",
    color: grasp.ink,
    backgroundColor: grasp.signInNight,
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
    backgroundColor: grasp.signInVeil,
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: { default: grasp.durationUi, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  veilOn: { opacity: 1 },
  top: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space4,
    textAlign: "start",
  },
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    [iconVars.size]: grasp.frameLogo,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    fontSize: grasp.titleSm,
    lineHeight: grasp.titleSmLine,
    letterSpacing: grasp.trackingUiTitle,
  },
  back: {
    color: grasp.muted,
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    [iconVars.size]: grasp.iconSm,
  },
  middle: {
    display: "grid",
    alignContent: "center",
    justifyItems: "center",
    gap: grasp.space10,
    width: "100%",
    maxWidth: grasp.signInColumn,
    marginInline: "auto",
    paddingBlock: grasp.space24,
  },
  head: { display: "grid", justifyItems: "center", gap: grasp.space3 },
  // Why someone is back stands with the ways it is about, closer than the title.
  act: {
    display: "grid",
    justifyItems: "center",
    gap: grasp.space5,
    width: "100%",
  },
  // The ways in: the website's plain white, which is the quiet button in the light scheme.
  ways: {
    display: "grid",
    gap: grasp.space3,
    width: "100%",
    maxWidth: grasp.signInWays,
    color: grasp.ink,
  },
  way: { position: "relative", display: "grid", color: grasp.ink },
  white: { colorScheme: "light" },
  wide: { width: "100%" },
  // The way used last time: a mint ring just outside the button's edge, so the button keeps its
  // size, and a small tag on its top edge.
  ring: {
    position: "absolute",
    inset: `calc(-1 * ${ringGap})`,
    pointerEvents: "none",
    borderRadius: `calc(${wayCorner} + ${ringGap})`,
    cornerShape: grasp.cornerShape,
    boxShadow: `0 0 0 ${grasp.ringWidth} ${grasp.mint}`,
  },
  // Where the "Last used" badge sits: on the way's top edge, towards its end.
  tag: {
    position: "absolute",
    top: 0,
    insetInlineEnd: grasp.space4,
    display: "flex",
    transform: "translateY(-50%)",
    pointerEvents: "none",
  },
  notice: { width: "100%", maxWidth: grasp.signInWays, textAlign: "start" },
  foot: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space4,
  },
  // Leaving: everything but the chosen way fades as the door opens at it.
  fades: {
    transitionProperty: "opacity",
    transitionDuration: { default: grasp.durationUi, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  gone: { opacity: 0 },
});

/** The page's words: the catalogue's, then the page's own over them. */
const useSignInWords = (given: SignInWordsGiven | undefined): SignInWords => {
  const words = useWords("signIn", signInWords);
  if (given === undefined) {
    return words;
  }
  return {
    ...words,
    ...given,
    notices: { ...words.notices, ...given.notices },
  };
};

/** The line a notice says, and its tone. */
const noticeOf = (notice: SignInNotice, words: SignInNoticeWords) =>
  typeof notice === "string"
    ? { plain: plainNotices.has(notice), words: words[notice] }
    : { plain: notice.tone === "plain", words: notice.words };

/** What this browser kept as "Last used", read where the page draws and followed while it stands. */
const useKeptLastUsed = (key: string) =>
  useSyncExternalStore(watchLastUsed, () => readLastUsed(key), noLastUsed);

/** The door on the page's canvas while it stands; none when `plain`. */
const useDoor = (plain: boolean, still: boolean) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const door = useRef<Door | null>(null);
  useEffect(() => {
    const element = canvas.current;
    const started =
      plain || element === null
        ? idleDoor
        : startDoor(element, still || matchMedia(REDUCED).matches);
    door.current = started;
    return () => {
      started.stop();
      door.current = null;
    };
  }, [plain, still]);
  return { canvas, door };
};

interface Way {
  id: string;
  name: string;
  words: string;
  icon: IconData;
  staff: boolean;
}

/** The page's title: the sign-in page's, the staff page's or the guest page's. */
const titleOf = (page: SignInProps["page"], words: SignInWords) => {
  if (page === "staff") {
    return words.staffTitle;
  }
  return page === "guest" ? words.guestTitle : words.title;
};

/** Leaves for the chosen way: its own `onSelect`, else the page's `onChoose`, else its address. */
const go = (
  provider: SignInProvider | undefined,
  staffHref: string | undefined,
  choose: () => void,
  chooses: boolean
) => {
  if (provider?.onSelect !== undefined) {
    provider.onSelect();
    return;
  }
  const href = provider?.href ?? staffHref;
  if (chooses || href === undefined) {
    choose();
    return;
  }
  window.location.assign(href);
};

/** The ways this page offers, the one used last time first. */
const waysOf = (
  providers: readonly SignInProvider[],
  staff: boolean,
  words: SignInWords,
  last: string
): Way[] => {
  const all: Way[] = [
    ...providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      words: words.way(provider.name),
      icon: provider.icon,
      staff: false,
    })),
    ...(staff
      ? [
          {
            id: "staff",
            name: words.brand,
            words: words.staff,
            icon: BrandGrasp,
            staff: true,
          },
        ]
      : []),
  ];
  return all.toSorted((a, b) => Number(b.id === last) - Number(a.id === last));
};

interface WaysProps {
  ways: readonly Way[];
  /** A press is playing the way out: every way but the chosen one fades. */
  gone: boolean;
  last: string;
  leaving: string | undefined;
  offline: boolean;
  words: SignInWords;
  choose: (id: string, event: MouseEvent<HTMLElement>) => void;
  aim: (on: boolean) => void;
}

/** The ways in, each a button to its provider; the one used last time first, ringed and tagged. */
const SignInWays = ({
  ways,
  gone,
  last,
  leaving,
  offline,
  words,
  choose,
  aim,
}: WaysProps) => (
  <div {...stylex.props(styles.ways)}>
    {ways.map((way) => (
      <div
        key={way.id}
        data-way={way.id}
        data-last-used={way.id === last ? "" : undefined}
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
        data-theme="light"
        {...stylex.props(
          styles.way,
          styles.white,
          styles.fades,
          gone && leaving !== way.id && styles.gone
        )}
      >
        <Button
          variant="quiet"
          size="lg"
          icon={way.icon}
          status={leaving === way.id ? "working" : "idle"}
          workingLabel={words.leaving(way.name)}
          doneLabel={words.opened}
          failedLabel={words.notOpened}
          disabled={offline || (leaving !== undefined && leaving !== way.id)}
          layout={styles.wide}
          onClick={(event: MouseEvent<HTMLElement>) => {
            choose(way.id, event);
          }}
        >
          {way.words}
        </Button>
        {way.id === last && (
          <>
            <span aria-hidden="true" {...stylex.props(styles.ring)} />
            <span {...stylex.props(styles.tag)}>
              <Badge tone="success" size="sm">
                {words.lastUsed}
              </Badge>
            </span>
          </>
        )}
      </div>
    ))}
  </div>
);

interface TopProps {
  words: SignInWords;
  backHref: string | undefined;
  gone: boolean;
}

/** Grasp's mark and name at the top start; the quiet way back at the top end. */
const SignInTop = ({ words, backHref, gone }: TopProps) => (
  <div {...stylex.props(styles.top, styles.fades, gone && styles.gone)}>
    <span {...stylex.props(styles.brand)}>
      <Icon icon={BrandGrasp} />
      {words.brand}
    </span>
    {backHref !== undefined && (
      <Text size="sm" tone="muted" element="span">
        <Link href={backHref} variant="standalone">
          <span {...stylex.props(styles.back)}>
            {words.back}
            <Icon icon={ArrowRight} />
          </span>
        </Link>
      </Text>
    )}
  </div>
);

interface FootProps {
  words: SignInWords;
  footHref: string | undefined;
  language: ReactNode;
  gone: boolean;
}

/** The quiet line at the foot, and the language switch. */
const SignInFoot = ({ words, footHref, language, gone }: FootProps) => (
  <div {...stylex.props(styles.foot, styles.fades, gone && styles.gone)}>
    {footHref !== undefined && (
      <Text size="sm" tone="muted" element="p">
        {words.foot} <Link href={footHref}>{words.footAction}</Link>
      </Text>
    )}
    {language}
  </div>
);

interface NoticeProps {
  notice: SignInNotice;
  words: SignInWords;
  gone: boolean;
}

/** Why someone is back, in one line over the buttons: plain, said politely; a refusal, at once. */
const SignInNoticeLine = ({ notice, words, gone }: NoticeProps) => {
  const said = noticeOf(notice, words.notices);
  return (
    <div {...stylex.props(styles.notice, styles.fades, gone && styles.gone)}>
      <Alert
        tone={said.plain ? "neutral" : "attention"}
        live={said.plain ? "polite" : "assertive"}
      >
        {said.words}
      </Alert>
    </div>
  );
};

/** The sign-in page: the door behind, the title, the ways in, and why someone is back. */
export const SignIn = ({
  providers,
  staff = false,
  page = "sign-in",
  notice,
  leaving: leavingGiven,
  lastUsed,
  rememberKey = lastUsedKey,
  onChoose,
  staffHref,
  organisation,
  language,
  backHref,
  footHref,
  children,
  words: wordsGiven,
  still = false,
  plain = false,
  layout,
}: SignInProps) => {
  const words = useSignInWords(wordsGiven);
  const titleId = useId();
  const kept = useKeptLastUsed(rememberKey);
  const { canvas, door } = useDoor(plain, still);
  // A press leaves for the provider: that button works while the door opens, the rest fades.
  const [pressed, setPressed] = useState<string>();
  const [aimed, setAimed] = useState(false);
  const leaving = pressed ?? leavingGiven;
  // A kept provider that is no longer offered is no "Last used".
  const wanted = lastUsed ?? kept;
  const last = providers.some((provider) => provider.id === wanted)
    ? wanted
    : "";
  const staffOnly = page === "staff";
  const ways = waysOf(
    staffOnly ? [] : providers,
    staff || staffOnly,
    words,
    last
  );
  // Only a press plays the way out; `leaving` from the host shows the state, everything still there.
  const gone = pressed !== undefined;
  const choose = (id: string, event: MouseEvent<HTMLElement>) => {
    if (leaving !== undefined) {
      return;
    }
    setPressed(id);
    setAimed(false);
    if (id !== "staff") {
      writeLastUsed(rememberKey, id);
    }
    const done = () => {
      go(
        providers.find((provider) => provider.id === id),
        id === "staff" ? staffHref : undefined,
        () => onChoose?.(id),
        onChoose !== undefined
      );
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
      data-slot="sign-in"
      data-page={page}
      data-theme="dark"
      onPointerMove={(event) => {
        point(event, true);
      }}
      onPointerDown={(event) => {
        point(event, true);
      }}
      onPointerLeave={(event) => {
        point(event, false);
      }}
      {...stylex.props(styles.page, layout)}
    >
      {!plain && (
        <canvas
          ref={canvas}
          aria-hidden="true"
          data-slot="sign-in-door"
          {...stylex.props(styles.canvas)}
        />
      )}
      <span
        aria-hidden="true"
        {...stylex.props(styles.veil, aimed && styles.veilOn)}
      />
      <SignInTop words={words} backHref={backHref} gone={gone} />
      <div {...stylex.props(styles.middle)}>
        <div {...stylex.props(styles.head, styles.fades, gone && styles.gone)}>
          {organisation}
          <Heading level={1} size="xl" id={titleId}>
            {titleOf(page, words)}
          </Heading>
        </div>
        <div {...stylex.props(styles.act)}>
          {notice !== undefined && (
            <SignInNoticeLine notice={notice} words={words} gone={gone} />
          )}
          {page === "guest" ? (
            children
          ) : (
            <SignInWays
              ways={ways}
              gone={gone}
              last={last}
              leaving={leaving}
              offline={notice === "offline"}
              words={words}
              choose={choose}
              aim={setAimed}
            />
          )}
        </div>
      </div>
      <SignInFoot
        words={words}
        footHref={footHref}
        language={language}
        gone={gone}
      />
    </section>
  );
};
