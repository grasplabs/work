import { filledMark } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";

// Grasp's own mark, as Damsko's Icon draws a brand: filled, in the ink, on
// its 24 grid. Damsko carries no brand marks (a product keeps them), so the
// product draws its own here. The four parts of the brand's mark
// (grasp-mark-ink.svg, a 29.2 by 24.7 grid) as one path, centred.

/** Grasp's mark, for `<Icon icon={GraspMark} />`: it follows the ink. */
export const GraspMark: IconData = filledMark([
  [
    "path",
    {
      key: "mark",
      d: "M5.73655 0L4.92188 4.55021H26.6572L27.4668 0H5.73655ZM15.1424 6.70117H2.0083L1.19531 11.2497H14.3277L15.1424 6.70117ZM13.9454 13.4023H0.812992L0 17.9509H13.1324L13.9454 13.4023ZM17.5191 6.70117L15.5077 17.9794H20.1365L21.3366 11.2497H23.6982L22.1193 20.1056H2.148L1.33838 24.6524H25.9352L29.1383 6.70117H17.5191Z",
      fill: "currentColor",
      transform: "translate(0 1.85) scale(0.8219)",
    },
  ],
]);
