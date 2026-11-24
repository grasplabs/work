/**
 * Linted by scripts/lint/no-inline-styles.test.ts with the repository's own
 * config: a `const` holding StyleX styles, named twice in one `style`, in
 * an array, a condition or both, is a placement each time, not a loop.
 */
import { Button } from "@grasp-os/ui/components/button";
import * as stylex from "@stylexjs/stylex";

const layout = stylex.create({ wide: { flexGrow: 1 } });

export const AliasTwice = ({
  open,
  active,
}: {
  open: boolean;
  active: boolean;
}) => {
  const wide = open ? layout.wide : undefined;
  const both = [wide, wide] as const;
  return (
    <>
      <Button style={[wide, active && wide]}>Save</Button>
      <Button style={active ? wide : wide}>Save</Button>
      <Button style={[both, active ? both : wide]}>Save</Button>
    </>
  );
};
