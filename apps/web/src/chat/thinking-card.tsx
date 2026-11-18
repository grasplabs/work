import type { ThinkingGround } from "@grasp-os/shared/brain";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import { useLessMotion } from "../brain/less-motion.ts";
import { useCardGround } from "../brain/thinking/card-ground.ts";
import {
  CARD_ROOM,
  cardView,
  linesOf,
  nervesOf,
  printed,
  threadPath,
  VIEW,
} from "../brain/thinking/card-print.ts";
import { cardGround } from "../brain/thinking/ground.ts";
import { roundHours } from "../brain/thinking/hours.ts";
import { SAG } from "../brain/thinking/layout.ts";
import type { ThinkingNeuron } from "../brain/thinking/layout.ts";
import { useThinkingLog } from "../brain/thinking/log.ts";
import { thinkAddress } from "../brain/thinking/play.ts";
import type { ThinkingOf } from "../brain/thinking/play.ts";
import { thinkingMap } from "../brain/thinking/shapes.ts";
import { usePlayedThinking } from "../brain/thinking/use-thinking.ts";
import { useWorkHoursText } from "../brain/thinking/work-hours.tsx";
import { focus } from "../grasp/focus/focus.ts";
import { ArrowRight, Brain, Icon } from "../grasp/icons/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// Grasp's thinking where the question was asked (GRA-1283; grasplabs/
// prototype `components/chat/thinking-card.tsx`): on any page but the
// brain, an answer that thought in the brain carries a card, a small
// picture of the shape with the same layout and the same beats as the
// dive, the line over it saying what the brain does as it goes. The somas
// are the brain's own dots under dotted dendrites, and the camera is
// fitted to the shape and follows it. Once the thinking is done it shows
// the finding; the whole card opens the brain, where it plays again.

const styles = stylex.create({
  // The card around the drawing: a link to the brain.
  card: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    width: "100%",
    overflow: "hidden",
    paddingInline: grasp.space4,
    paddingBlockStart: grasp.space3,
    paddingBlockEnd: grasp.space2,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: grasp.line, ":hover": grasp.edge },
    borderRadius: grasp.corner,
    backgroundColor: grasp.raised,
    color: grasp.text,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textDecorationLine: "none",
    transitionProperty: "border-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space2,
    minHeight: grasp.space10,
    textAlign: "center",
    fontWeight: grasp.weightMedium,
    textWrap: "balance",
  },
  // At most two lines of what it thinks about now.
  line: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
  },
  foot: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    paddingBlockStart: grasp.space2,
    borderBlockStartWidth: 1,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
    color: grasp.muted,
  },
  grow: { flexGrow: 1 },
});
/**
 * A workflow's hours in the card, as text for its SVG: in full, or only
 * the number where the name has no room. Text alone, as SVG paints no
 * HTML element inside it.
 */
const CardHours = ({
  hours,
  short,
}: {
  hours: number | null;
  short: boolean;
}) => {
  const { i18n } = useLingui();
  const full = useWorkHoursText(hours);
  return !short || hours === null
    ? full
    : new Intl.NumberFormat(i18n.locale).format(roundHours(hours));
};

/** Watches an element's width, `fallback` while it has none; the way to stop. */
const watchWidth = (
  element: Element,
  setWidth: (width: number) => void,
  fallback: number
): (() => void) => {
  const sizes = new ResizeObserver(([entry]) => {
    const width = entry?.contentRect.width ?? 0;
    setWidth(width > 0 ? width : fallback);
  });
  sizes.observe(element);
  return () => {
    sizes.disconnect();
  };
};

/** How wide an element is on screen, as it changes; `fallback` until it is measured. */
const useWidth = (element: Element | null, fallback: number): number => {
  const [width, setWidth] = useState(fallback);
  useEffect(
    () =>
      element === null ? undefined : watchWidth(element, setWidth, fallback),
    [element, fallback]
  );
  return width;
};

/** A neuron of the shape, printed from the brain's own designs; warm while a beat names it, faint while it names another. `text`: picture units to pixels on screen; `letters`: how many a line of its name may take, none where only its hours fit. */
const ShapeNeuron = ({
  neuron,
  warm,
  faint,
  named,
  text,
  letters,
}: {
  neuron: ThinkingNeuron;
  warm: boolean;
  faint: boolean;
  named: boolean;
  text: number;
  letters: number;
}) => {
  // Printed again only when its size on screen changes by a few pixels.
  const onPage = Math.round((neuron.r * text) / 3) * 3;
  const dots = printed(neuron, onPage);
  const { hours } = neuron;
  let tone = "text-foreground";
  if (warm) {
    tone = "text-brain-heat";
  } else if (neuron.state === "open") {
    tone = "text-muted-foreground";
  }
  return (
    <g
      // The drawing's own classes (styles.css), kept as it is drawn.
      className={[
        tone,
        "transition-opacity duration-300 motion-reduce:transition-none",
        faint ? "opacity-30" : "",
      ].join(" ")}
    >
      <title>{neuron.label}</title>
      {/* Its soma and dendrites, in its own radius, so it grows where it stands when the shape moves on: the transform is an SVG attribute, which the class's transition eases as it changes. */}
      <g
        className="transition-transform duration-300 ease-out motion-reduce:transition-none"
        fill="currentColor"
        transform={`translate(${neuron.x} ${-neuron.y}) scale(${neuron.r})`}
      >
        {dots.map((dot, at) => (
          <circle cx={dot.x} cy={dot.y} key={at} opacity={dot.a} r={dot.r} />
        ))}
      </g>
      {named && neuron.bare !== true ? (
        // The words keep their size on screen however close the card looks.
        <text
          className="fill-foreground font-medium"
          fontSize={12 / text}
          textAnchor="middle"
          x={neuron.x}
          y={-neuron.y + neuron.r + 15 / text}
        >
          {letters > 0
            ? linesOf(neuron.label, letters).map((line, at) => (
                <tspan dy={at === 0 ? 0 : 14 / text} key={at} x={neuron.x}>
                  {line}
                </tspan>
              ))
            : null}
          {hours === undefined ? null : (
            <tspan
              className="fill-muted-foreground font-normal"
              dy={letters > 0 ? 15 / text : 0}
              x={neuron.x}
            >
              <CardHours hours={hours} short={letters === 0} />
            </tspan>
          )}
        </text>
      ) : null}
    </g>
  );
};

/**
 * The card, once what it is drawn from is read; `instead` where the
 * thinking has nothing to show. Its inputs stay the same from chunk to
 * chunk of the answer (the steps, what was read, when each step arrived),
 * so the compiler keeps the shape, its layout and each neuron's print, and
 * draws again only what a beat changes.
 */
const Card = ({
  chatId,
  thinking,
  live,
  read,
  instead,
}: {
  chatId: string;
  thinking: ThinkingOf;
  live: boolean;
  read: ThinkingGround;
  instead: ReactElement | null;
}) => {
  const { i18n } = useLingui();
  const lessMotion = useLessMotion();
  const { arrived } = useThinkingLog();
  const arrivals = thinking.calls.map((call) => arrived.get(call));
  // Seen as it came in this tab, it plays to its end; an answer from before shows the shape it ended in.
  const played = usePlayedThinking(
    `card:${chatId}:${thinking.questionId}`,
    thinking.steps,
    {
      ground: cardGround(read),
      still: lessMotion || arrivals.every((at) => at === undefined),
      arrivals,
      open: live,
      i18n,
    }
  );
  const [picture, setPicture] = useState<SVGSVGElement | null>(null);
  // The picture's width on screen, so its words keep their size on a phone as on a wide screen.
  const shown = useWidth(picture, VIEW.width);
  const { figure } = played;
  if (figure === undefined) {
    return instead;
  }
  const map = thinkingMap(figure, CARD_ROOM);
  const view = cardView(map, shown);
  const lit = new Set(played.beat?.lit);
  const byId = new Map(map.neurons.map((neuron) => [neuron.id, neuron]));
  const [from, to] = (played.beat?.thread ?? []).map((id) => byId.get(id));
  return (
    <Link
      search={{ think: thinkAddress(chatId, thinking.questionId) }}
      to="/brain"
      {...stylex.props(styles.card, focus.ring)}
    >
      <span {...stylex.props(styles.head)}>
        {played.going ? <Spinner size="sm" /> : null}
        <span key={played.text} {...stylex.props(styles.line)}>
          {played.text}
        </span>
      </span>
      <svg
        aria-hidden="true"
        className="h-auto w-full"
        ref={setPicture}
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
      >
        <g
          className="transition-transform duration-300 ease-out motion-reduce:transition-none"
          transform={view.camera}
        >
          {nervesOf(map, view.text).map(({ id, dots }) => (
            <g className="fill-brain-heat" key={id}>
              {dots.map((dot, at) => (
                <circle
                  cx={dot.x}
                  cy={dot.y}
                  key={at}
                  opacity={dot.a}
                  r={dot.r}
                />
              ))}
            </g>
          ))}
          {from === undefined || to === undefined ? null : (
            <path
              className="draw-thread stroke-brain-heat"
              d={threadPath(from, to, SAG)}
              fill="none"
              key={`${played.beat?.since}:${from.id}`}
              pathLength={1}
              strokeDasharray="1 1"
              strokeLinecap="round"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {map.neurons.map((neuron) => (
            <ShapeNeuron
              faint={lit.size > 0 && !lit.has(neuron.id)}
              key={neuron.id}
              letters={view.letters}
              named={view.naming && neuron.quiet !== true}
              neuron={neuron}
              text={view.text}
              warm={lit.has(neuron.id)}
            />
          ))}
        </g>
      </svg>
      <span {...stylex.props(styles.foot)}>
        <Icon icon={Brain} />
        <span {...stylex.props(styles.grow)}>
          <Trans>See it in the brain</Trans>
        </span>
        <Icon icon={ArrowRight} />
      </span>
    </Link>
  );
};

/**
 * An answer's thinking as a card, on any page but the brain: plays as
 * Grasp answers (`live`, each step as it reached the tab), else shows the
 * shape it ended in. `instead` while what it is drawn from is read, and
 * where that can't be read or the thinking has nothing to show.
 */
export const ThinkingCard = ({
  chatId,
  thinking,
  live,
  instead,
}: {
  chatId: string;
  thinking: ThinkingOf;
  live: boolean;
  instead: ReactElement | null;
}) => {
  const read = useCardGround();
  return read === undefined || read === null ? (
    instead
  ) : (
    <Card
      chatId={chatId}
      instead={instead}
      live={live}
      read={read}
      thinking={thinking}
    />
  );
};
