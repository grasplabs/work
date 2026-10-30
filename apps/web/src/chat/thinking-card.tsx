import type { ThinkingGround } from "@grasp-os/shared/brain";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { cn } from "@grasp-os/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
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
import { WorkHours } from "../brain/thinking/work-hours.tsx";

// Grasp's thinking where the question was asked (GRA-1283; grasplabs/
// prototype `components/chat/thinking-card.tsx`): on any page but the
// brain, an answer that thought in the brain carries a card, a small
// picture of the shape with the same layout and the same beats as the
// dive, the line over it saying what the brain does as it goes. The somas
// are the brain's own dots under dotted dendrites, and the camera is
// fitted to the shape and follows it. Once the thinking is done it shows
// the finding; the whole card opens the brain, where it plays again.

/** A workflow's hours in the card: in full, or only the number where the name has no room. */
const CardHours = ({
  hours,
  short,
}: {
  hours: number | null;
  short: boolean;
}) => {
  const { i18n } = useLingui();
  return !short || hours === null ? (
    <WorkHours hours={hours} />
  ) : (
    <>{new Intl.NumberFormat(i18n.locale).format(roundHours(hours))}</>
  );
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
  const onScreen = Math.round((neuron.r * text) / 3) * 3;
  const dots = printed(neuron, onScreen);
  const { hours } = neuron;
  let tone = "text-foreground";
  if (warm) {
    tone = "text-brain-heat";
  } else if (neuron.state === "open") {
    tone = "text-muted-foreground";
  }
  return (
    <g
      className={cn(
        tone,
        "transition-opacity duration-300 motion-reduce:transition-none",
        faint && "opacity-30"
      )}
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
      className="group bg-card hover:border-foreground/30 focus-visible:ring-ring/50 flex w-full flex-col gap-2 overflow-hidden rounded-xl border px-4 pt-3 pb-2 text-sm transition-colors duration-200 outline-none focus-visible:ring-3"
      search={{ think: thinkAddress(chatId, thinking.questionId) }}
      to="/brain"
    >
      <span className="flex min-h-10 items-center justify-center gap-2 text-center font-medium text-balance">
        {played.going ? <Spinner className="size-3.5" /> : null}
        <span
          className="animate-in fade-in line-clamp-2 duration-200 motion-reduce:animate-none"
          key={played.text}
        >
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
      <span className="text-muted-foreground group-hover:text-foreground flex items-center gap-1.5 border-t pt-2">
        <BrainIcon aria-hidden="true" className="size-4" />
        <span className="flex-1">
          <Trans>See it in the brain</Trans>
        </span>
        <ChevronRightIcon aria-hidden="true" className="size-4" />
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
