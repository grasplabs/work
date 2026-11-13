import type { RefObject } from "react";

import { isDithered, isSand, isScene } from "./look.ts";
import type { Look } from "./look.ts";
import { ParticleField } from "./particle-field.tsx";
import { ShaderField } from "./shader-field.tsx";

/**
 * A look itself (look.ts), behind what it is placed under: fills a box
 * with a position of its own.
 */
export const BackdropField = ({
  look,
  clear,
}: {
  look: Look;
  /** What the sand fades out around. */
  clear?: RefObject<HTMLElement | null>;
}) => {
  const { backdrop, pattern, tone } = look;
  if (isSand(backdrop)) {
    return <ParticleField clear={clear} key={backdrop} kind={backdrop} />;
  }
  if (isScene(backdrop)) {
    return <ShaderField key={backdrop} kind={backdrop} />;
  }
  return isDithered(backdrop) ? (
    <ShaderField
      dither={{ pattern, tone }}
      key={`${backdrop}:${pattern}:${tone}`}
      kind={backdrop}
    />
  ) : null;
};
