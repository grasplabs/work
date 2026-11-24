import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { media, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { copy, fixture } from "./fixture.ts";
import { DitherOver } from "./frame.tsx";

// CONCEPT ONLY: the ways out of the start (start-clean.tsx), as few words
// as honestly do. "Not now" offers a time to be reminded; "I'd rather not"
// is said once more and taken; a pause in the conversation keeps the place
// and the minutes.

const styles = stylex.create({
  // A page of its own, its column in the middle of its half, scrolled in its own room when the window is low.
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "safe center",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    boxSizing: "border-box",
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
    paddingBlock: { default: space["6"], [media.sm]: space["10"] },
  },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: { default: space["6"], [media.sm]: space["8"] },
    width: "100%",
    maxWidth: "28rem",
    // One centred axis, as the start (Ruben, 24 November).
    textAlign: "center",
  },
  words: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["3"],
  },
  actions: { display: "flex", flexDirection: "column", gap: space["3"] },
  quiet: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space["2"],
  },
  // The suggested time: its dither clipped to the Item's own corner (the Item's token), above its fill.
  suggested: {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
    borderRadius: radius.lg,
  },
});

/** A page of its own: one column in the middle of its room. */
const Page = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.page)}>
    <div {...stylex.props(styles.column)}>{children}</div>
  </div>
);

/** A page's title, and a line under it. */
const Words = ({ title, line }: { title: string; line: string }) => (
  <div {...stylex.props(styles.words)}>
    <Heading level={1} size="xl">
      {title}
    </Heading>
    <Text size="lg">{line}</Text>
  </div>
);

/** The reminder time we would pick: tomorrow morning, a fresh start. */
const suggested = "tomorrow";

/** "Not now": when to be reminded, one press: the time first, the day under it. */
export const NotNow = ({
  onPick,
  onBack,
}: {
  onPick: (when: string) => void;
  onBack: () => void;
}) => (
  <Page>
    <Words line={copy.later.line} title={copy.later.title} />
    <ItemGroup aria-label="Remind me">
      {fixture.remindAt.map((each) => {
        const item = (
          <Item
            onClick={() => {
              onPick(each.when);
            }}
            size="sm"
            variant="outline"
          >
            <ItemContent>
              <ItemTitle>{each.time}</ItemTitle>
              <ItemDescription>{each.day}</ItemDescription>
            </ItemContent>
          </Item>
        );
        // The one we would pick carries the header's calm dither.
        return each.id === suggested ? (
          <div key={each.id} {...stylex.props(styles.suggested)}>
            {item}
            <DitherOver />
          </div>
        ) : (
          <div key={each.id}>{item}</div>
        );
      })}
    </ItemGroup>
    <div {...stylex.props(styles.quiet)}>
      <Button onClick={onBack} variant="link">
        {copy.later.back}
      </Button>
    </div>
  </Page>
);

/** "Not now" taken. */
export const Reminded = ({
  when,
  onStart,
}: {
  when: string;
  onStart: () => void;
}) => (
  <Page>
    <Words
      line={`${copy.later.doneRest(when)} ${copy.later.doneLine}`}
      title={copy.later.doneHead}
    />
    <div {...stylex.props(styles.actions)}>
      <Button onClick={onStart} size="lg" variant="outline">
        {copy.later.doneStart}
      </Button>
    </div>
  </Page>
);

/** "I'd rather not": said once more, so a slip of the thumb isn't a no. */
export const RatherNot = ({
  onConfirm,
  onBack,
}: {
  onConfirm: () => void;
  onBack: () => void;
}) => (
  <Page>
    <Words line={copy.decline.line} title={copy.decline.title} />
    <div {...stylex.props(styles.actions)}>
      <Button onClick={onConfirm} size="lg">
        {copy.decline.yes}
      </Button>
      <div {...stylex.props(styles.quiet)}>
        <Button onClick={onBack} variant="link">
          {copy.decline.back}
        </Button>
      </div>
    </div>
  </Page>
);

/** "I'd rather not" taken. */
export const Declined = ({ onUndo }: { onUndo: () => void }) => (
  <Page>
    <Words line={copy.decline.doneLine} title={copy.decline.doneTitle} />
    <div {...stylex.props(styles.actions)}>
      <Button onClick={onUndo} size="lg" variant="outline">
        {copy.decline.undo}
      </Button>
    </div>
  </Page>
);

/** Stopped for now in the conversation: the place and the minutes are kept. */
export const Paused = ({
  minutesLeft,
  onCarryOn,
}: {
  minutesLeft: number;
  onCarryOn: () => void;
}) => (
  <Page>
    <Words line={copy.paused.line(minutesLeft)} title={copy.paused.title} />
    <div {...stylex.props(styles.actions)}>
      <Button onClick={onCarryOn} size="lg">
        {copy.paused.carryOn}
      </Button>
    </div>
  </Page>
);
