import type { Locale } from "../i18n.ts";
import { colourAt, flags } from "./flags.ts";

// A language's flag, small, beside its name in a language picker: the same
// flag the language cards draw (flags.ts), as a grid of pixels in its real
// colours, the brand's own grain at the size of a word. Its corners are
// cut round and a faint edge keeps a white band apart from a white page.
// Decoration: the name beside it says which language it is.

/** How many pixels the flag is high; its width follows its own aspect. */
const ROWS = 8;

export const FlagMark = ({ locale }: { locale: Locale }) => {
  const flag = flags[locale];
  // A small flag reads better a little narrower than the real one.
  const columns = Math.round(ROWS * Math.min(flag.aspect, 1.6));
  const cells = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const colour =
        flag.real[
          colourAt(flag.shape, (column + 0.5) / columns, (row + 0.5) / ROWS)
        ];
      cells.push(
        <rect
          fill={colour}
          height={1}
          key={`${column}-${row}`}
          width={1}
          x={column}
          y={row}
        />
      );
    }
  }
  const clip = `flag-${locale}`;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      height="0.75em"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${columns} ${ROWS}`}
      width={`${(0.75 * columns) / ROWS}em`}
    >
      <clipPath id={clip}>
        <rect height={ROWS} rx={1.2} width={columns} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>{cells}</g>
      <rect
        fill="none"
        height={ROWS - 0.2}
        opacity={0.18}
        rx={1.1}
        shapeRendering="geometricPrecision"
        stroke="currentColor"
        strokeWidth={0.2}
        width={columns - 0.2}
        x={0.1}
        y={0.1}
      />
    </svg>
  );
};
