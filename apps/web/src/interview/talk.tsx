import { interviewPhases } from "@grasp-os/shared/interview-links";
import type { FactTag } from "@grasp-os/shared/interview-turn";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { Head, headSizes, useHead } from "./head.tsx";
import { useLoop } from "./loop.ts";
import { markedPieces } from "./progress.ts";
import { shownAs, SpokenText, useSaid } from "./spoken.tsx";

// The conversation (prototype `interview-talk.tsx`, `Talk`): Stephen in
// the middle, as large as the window leaves him, asking one thing, his
// words lighting up as he says them; beside him a small sign of what he is
// doing. Then he waits for what they type in the box at the bottom.

/** How full he is printed: fuller as the interview goes on. */
export const fillOf = (phase: (typeof interviewPhases)[number]): number =>
  0.35 + (0.65 * interviewPhases.indexOf(phase)) / (interviewPhases.length - 1);

export const Talk = ({
  room,
  phase,
}: {
  room: number;
  phase: (typeof interviewPhases)[number];
}) => {
  const { t } = useLingui();
  const loop = useLoop();
  const { body, size } = useHead(room, headSizes.talking);
  const { title, rest } = shownAs(loop.line);
  const said = useSaid({
    line: loop.line,
    saying: loop.saying,
    from: loop.from,
    speaking: loop.doing === "speaking",
  });
  let label = t`Stephen, asking.`;
  if (loop.doing === "listening") {
    label = t`Stephen, listening.`;
  } else if (loop.doing === "thinking") {
    label = t`Stephen, thinking.`;
  }
  return (
    <div className="flex w-full max-w-xl flex-col items-center gap-6 text-center">
      <Head fill={fillOf(phase)} label={label} sign={loop.sign} size={size} />
      <div
        aria-live="polite"
        className="flex min-h-36 w-full flex-col items-center gap-5"
        ref={body}
      >
        {loop.line === "" ? null : (
          <div
            className="animate-in fade-in slide-in-from-bottom-2 flex max-w-lg flex-col gap-2 duration-500"
            key={loop.saying}
          >
            <p className="text-2xl font-medium tracking-tight text-balance">
              <SpokenText said={said} text={title} />
            </p>
            {rest === "" ? null : (
              <p className="text-muted-foreground text-balance">
                <SpokenText from={title.length + 1} said={said} text={rest} />
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** Something the person said, with what Stephen marked in it: each mark says what it is when pointed at. */
export const Marked = ({
  text,
  marks,
  names,
}: {
  text: string;
  marks: { quote: string; tag: FactTag }[];
  names: Record<FactTag, string>;
}) => (
  <>
    {markedPieces(text, marks).map((piece) =>
      piece.tag === null ? (
        <span key={piece.at}>{piece.text}</span>
      ) : (
        <mark
          className="bg-brain-heat/15 -mx-0.5 rounded-sm box-decoration-clone px-0.5 text-inherit"
          key={piece.at}
          title={names[piece.tag]}
        >
          {piece.text}
        </mark>
      )
    )}
  </>
);

/**
 * Something the person said, as their side of a chat: a bubble on the
 * right with a small tail at its foot pointing to them, so it is seen at
 * once whose words these are.
 */
export const Own = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <div className={cn("relative flex justify-end pr-2.5", className)}>
    <div className="bg-secondary text-secondary-foreground max-w-11/12 rounded-xl rounded-br-xs px-3 py-2 text-left text-sm leading-relaxed wrap-break-word whitespace-pre-wrap">
      {children}
    </div>
    <svg
      aria-hidden="true"
      className="fill-secondary absolute right-0 bottom-0 h-3.5 w-2.5"
      viewBox="0 0 10 14"
    >
      <path d="M0 0 C0 7 3 12 10 14 L0 14 Z" />
    </svg>
  </div>
);
