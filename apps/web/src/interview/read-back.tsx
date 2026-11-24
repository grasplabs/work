import type { InterviewFact } from "@grasp-os/shared/interview-links";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, XIcon } from "@grasp-os/ui/lib/icons";
import { fadeIn, focusRing } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useRef, useState } from "react";

import { Destination, moveLine } from "./destination.tsx";
import { Head, headSizes, useHead } from "./head.tsx";
import { voice } from "./interview.stylex.ts";
import { update, useInterviewer, useProgress } from "./kept.ts";
import { fullWidth, looks } from "./looks.ts";
import { agreeToPart, changeLine, useLoop } from "./loop.ts";
import type { LoopState } from "./loop.ts";
import { partAt, withFactsBack, withFactToggled } from "./progress.ts";
import { useSaidIn, voiceLevel } from "./speech.ts";
import { SpokenText } from "./spoken.tsx";
import { usePromise } from "./words.ts";

// The read-back (prototype `interview-talk.tsx`, `ReadBack`): one part at
// a time, a few lines each, so it is read, checked and agreed to without
// scrolling. Stephen tells the lines back as a short story, and each lights
// up as he gets to it. A line is put right where it is, or taken out; the
// button agrees to what is left. What they type is taken as a correction.
// What they leave in is what counts.

const styles = stylex.create({
  lines: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    margin: 0,
    padding: 0,
    listStyle: "none",
    textAlign: "start",
    borderBlockEndWidth: sizes.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  item: {
    borderBlockStartWidth: sizes.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  // The line, and where it goes under it.
  line: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["1"],
    paddingBlock: space["1"],
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space["3"],
    width: "100%",
  },
  field: { flexGrow: 1, minWidth: 0 },
  // The line itself, pressed to put it right where it is.
  words: {
    display: "block",
    width: "100%",
    margin: 0,
    paddingBlock: space["1"],
    paddingInline: 0,
    borderWidth: 0,
    borderRadius: radius.base,
    backgroundColor: {
      default: "transparent",
      [media.hover]: {
        default: "transparent",
        ":hover": colors.secondaryHover,
      },
    },
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    textAlign: "start",
    cursor: "text",
  },
  said: {
    color: colors.foreground,
    transitionProperty: "color",
    transitionDuration: duration.ui,
  },
  saying: {
    color: voice.heat,
    transitionProperty: "color",
    transitionDuration: duration.hover,
  },
  waiting: {
    color: colors.subtleForeground,
    transitionProperty: "color",
    transitionDuration: duration.ui,
  },
  taken: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: space["1"],
  },
});

/** A line of the read-back while he tells it: told, being told, or still to come. */
const toldLooks = {
  said: styles.said,
  saying: styles.saying,
  waiting: styles.waiting,
} as const;

const toldOf = (
  telling: LoopState["telling"],
  id: string
): keyof typeof toldLooks | null => {
  if (telling === null) {
    return null;
  }
  if (telling.now.includes(id)) {
    return "saying";
  }
  return telling.told.includes(id) ? "said" : "waiting";
};

/**
 * A line that can be put right where it is: a press turns it into a field
 * with its words; Enter or leaving it keeps the change and Stephen hears of
 * it; Escape lets it be. Under it, where it goes (`Destination`).
 */
const ReadBackLine = ({
  id,
  text,
  tag,
  share,
  told,
}: Pick<InterviewFact, "id" | "text" | "tag" | "share"> & {
  told: keyof typeof toldLooks | null;
}) => {
  const { t } = useLingui();
  const words = useId();
  const [draft, setDraft] = useState<string | null>(null);
  // Escape lets it be, also when leaving the field follows.
  const letBe = useRef(false);
  const keep = (): void => {
    const now = draft?.trim() ?? "";
    setDraft(null);
    if (letBe.current || now === "" || now === text) {
      return;
    }
    changeLine(id, text, now);
  };
  return (
    <div {...stylex.props(styles.line)}>
      <div {...stylex.props(styles.row)}>
        <span {...stylex.props(styles.field)}>
          {draft === null ? (
            <button
              aria-label={t`Change: ${text}`}
              onClick={() => {
                letBe.current = false;
                setDraft(text);
              }}
              type="button"
              {...stylex.props(styles.words, focusRing)}
            >
              <span
                id={words}
                {...stylex.props(told !== null && toldLooks[told])}
              >
                {text}
              </span>
            </button>
          ) : (
            <Input
              aria-label={t`Change: ${text}`}
              // The field takes the keys the moment it opens, with the cursor after its words.
              autoFocus
              maxLength={300}
              onBlur={keep}
              onValueChange={(value) => {
                setDraft(value);
              }}
              onFocus={(event) => {
                const { length } = event.target.value;
                event.target.setSelectionRange(length, length);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  keep();
                } else if (event.key === "Escape") {
                  letBe.current = true;
                  setDraft(null);
                }
              }}
              value={draft}
            />
          )}
        </span>
        <Button
          aria-label={t`Take out: ${text}`}
          onClick={() => {
            update((progress) => withFactToggled(progress, id));
          }}
          size="icon-sm"
          variant="ghost"
        >
          <Icon icon={XIcon} />
        </Button>
      </div>
      <Destination
        // The line's words describe it; while they are being put right,
        // the field holds them, and nothing that isn't there is named.
        of={draft === null ? words : undefined}
        onMove={() => {
          moveLine(id, share);
        }}
        share={share}
        tag={tag}
      />
    </div>
  );
};

export const ReadBack = ({ room }: { room: number }) => {
  const { t } = useLingui();
  const promise = usePromise();
  const loop = useLoop();
  const progress = useProgress();
  const interviewer = useInterviewer();
  const who = interviewerNames[interviewer];
  const { parts, at, part } = partAt(progress);
  const { body, size } = useHead(room, headSizes.reading);
  const saidIn = useSaidIn(loop.line, loop.from);
  // What he says lights up as he says it; while he tells the lines, they light up instead.
  const said =
    loop.doing === "speaking" && loop.telling === null
      ? Math.max(loop.from, saidIn)
      : -1;
  if (part === undefined) {
    return null;
  }
  const left = part.facts.filter(({ out }) => out !== true);
  const out = part.facts.filter(({ out: taken }) => taken === true);
  const taken = plural(out.length, {
    one: "# line taken out.",
    other: "# lines taken out.",
  });
  let agree = t`Yes, that’s correct`;
  if (left.length === 0) {
    agree = t`None of this is right`;
  } else if (out.length > 0) {
    agree = t`The rest is correct`;
  }
  const n = at + 1;
  const count = parts.length;
  return (
    <div {...stylex.props(looks.screen)}>
      <Head
        fill={1}
        label={t`${who}, reading back.`}
        sign={loop.sign}
        size={size}
        voice={voiceLevel}
        who={interviewer}
      />
      <div ref={body} {...stylex.props(looks.body)}>
        <div aria-live="polite">
          <h1 {...stylex.props(looks.said)}>
            <SpokenText said={said} text={loop.line} />
          </h1>
        </div>
        {/* How much there is still to check: nobody agrees with care to pages without an end in sight. */}
        {count > 1 ? (
          <Text color="muted" size="xs">{t`Part ${n} of ${count}`}</Text>
        ) : null}
        <ol {...stylex.props(styles.lines)}>
          {left.map(({ id, text, tag, share }) => (
            <li key={id} {...stylex.props(styles.item, fadeIn)}>
              <ReadBackLine
                id={id}
                share={share}
                tag={tag}
                text={text}
                told={toldOf(loop.telling, id)}
              />
            </li>
          ))}
        </ol>
        {out.length > 0 ? (
          <div aria-live="polite" {...stylex.props(styles.taken)}>
            <Text as="span" color="muted" size="xs">
              {taken}
            </Text>
            <Button
              onClick={() => {
                const ids = out.map(({ id }) => id);
                update((now) => withFactsBack(now, ids));
              }}
              size="xs"
              variant="ghost"
            >
              {t`Put back`}
            </Button>
          </div>
        ) : null}
        <div {...stylex.props(looks.actions)}>
          <div {...stylex.props(fullWidth.button)}>
            <Button
              disabled={loop.doing === "idle"}
              onClick={() => {
                agreeToPart(out.length > 0 ? `${agree}.` : undefined);
              }}
              size="lg"
            >
              {agree}
            </Button>
          </div>
          <Text
            color="muted"
            size="xs"
          >{t`Press a line to change it, take out what is wrong, or type what is missing. Choose where each line goes. What you leave in is what counts.`}</Text>
          {at === parts.length - 1 ? (
            <Text color="muted" size="xs">
              {promise}
            </Text>
          ) : null}
        </div>
      </div>
    </div>
  );
};
