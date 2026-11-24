import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// CONCEPT ONLY: the read-back's concepts come in Part 2 of the pull request.

const styles = stylex.create({
  page: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space["4"],
  },
});

export const ReadBackPlaceholder = () => (
  <div {...stylex.props(styles.page)}>
    <Empty>
      <EmptyHeader>
        <EmptyTitle>The read-back</EmptyTitle>
        <EmptyDescription>
          Its three concepts follow in Part 2.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
);
