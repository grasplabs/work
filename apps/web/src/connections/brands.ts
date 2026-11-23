import type { OAuthProvider } from "@grasp-os/shared/connect";
// The marks the product draws itself, for Grasp's own connectors: core
// serves no logo for them (their `CatalogEntry.logo` is null), unlike a
// Composio toolkit's. Keyed by the connector's id, the one thing that
// picks one (provider-mark.tsx); Recommended draws a suite's beside its
// reason.
// Each is filled and in the company's own colours, never a line redraw
// (Damsko draws no brands: its BrandIcon takes the product's, made with
// `filledMark`). Two small marks, drawn on the same pages: one module.
//
// A mark is a list of filled parts, its own grid placed on the 24 grid and
// sized by eye.
import { filledMark } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";

interface Part {
  d: string;
  fill: string;
}

/** A brand's parts as drawing data, placed on the 24 grid by `transform`. */
const brandMark = (transform: string, parts: Part[]): IconData =>
  filledMark(
    parts.map(
      (part, index) =>
        [
          "path",
          { key: `part-${index}`, d: part.d, fill: part.fill, transform },
        ] as const
    )
  );

/** Google (its G), for Google Workspace. */
const BrandGoogle: IconData = brandMark("translate(0.96 0.96) scale(0.46)", [
  {
    d: "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z",
    fill: "#EA4335",
  },
  {
    d: "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z",
    fill: "#4285F4",
  },
  {
    d: "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z",
    fill: "#FBBC05",
  },
  {
    d: "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z",
    fill: "#34A853",
  },
]);
/** Microsoft, for Microsoft 365. */
const BrandMicrosoft: IconData = brandMark("translate(1.92 1.92) scale(0.84)", [
  { d: "M0 0h11.408v11.408H0z", fill: "#F25022" },
  { d: "M12.594 0H24v11.408H12.594z", fill: "#7FBA00" },
  { d: "M0 12.594h11.408V24H0z", fill: "#00A4EF" },
  { d: "M12.594 12.594H24V24H12.594z", fill: "#FFB900" },
]);

/** The mark of each of Grasp's own connectors, by its id, and the name its company goes by. */
export const brands = {
  microsoft: { logo: BrandMicrosoft, name: "Microsoft" },
  google: { logo: BrandGoogle, name: "Google" },
} as const satisfies Record<OAuthProvider, { logo: IconData; name: string }>;

/** A connector with a mark of its own. */
export type Brand = keyof typeof brands;
