import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Skeleton } from "../grasp/skeleton/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// A chat loading, in its thread's place: the shape of a question and its
// answer, as the library's chat page pattern draws it. No part draws a
// thread loading yet, so the shape is made of Skeletons; it goes once
// Thread has a loading look of its own.

const styles = stylex.create({
  loading: {
    display: "grid",
    rowGap: grasp.space6,
    paddingBlock: grasp.space6,
  },
  mine: { justifySelf: "end", width: "min(60%, 24rem)", height: grasp.space12 },
  line: { width: "100%" },
  lineShort: { width: "60%" },
  theirs: { display: "grid", rowGap: grasp.space2 },
});

/** The shape of a question and its answer while a chat loads. */
export const ThreadLoading = () => {
  const { t } = useLingui();
  return (
    <div
      aria-busy="true"
      aria-label={t`Loading…`}
      {...stylex.props(styles.loading)}
    >
      <Skeleton layout={styles.mine} variant="block" />
      <div {...stylex.props(styles.theirs)}>
        <Skeleton layout={styles.line} text="md" />
        <Skeleton layout={styles.line} text="md" />
        <Skeleton layout={styles.lineShort} text="md" />
      </div>
    </div>
  );
};
