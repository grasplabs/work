import { filledMark } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";

// Other companies' own marks, and Grasp's: a brand is drawn as the brand
// draws itself, filled and in its own colours, never as a line redraw, so
// these are the product's and not Damsko's (its icons are Hugeicons only).
// Each is a list of filled parts on Damsko's 24 grid, with the transform
// that places the brand's own grid in it; a part in `currentColor` follows
// the ink. Vendored from Simple Icons (CC0, simpleicons.org) and the
// brands' published colours, 16 November 2026.

interface Part {
  d: string;
  fill: string;
}

/** A brand's parts as drawing data, placed on the 24 grid. */
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

// Source: Grasp's own mark (public/brand/grasp-mark-ink.svg), its four
// parts as one path on its 29.2 by 24.7 grid, centred; follows the ink.
/** Grasp, our own mark. */
export const GraspLogo: IconData = brandMark(
  "translate(0 1.85) scale(0.8219)",
  [
    {
      d: "M5.73655 0L4.92188 4.55021H26.6572L27.4668 0H5.73655ZM15.1424 6.70117H2.0083L1.19531 11.2497H14.3277L15.1424 6.70117ZM13.9454 13.4023H0.812992L0 17.9509H13.1324L13.9454 13.4023ZM17.5191 6.70117L15.5077 17.9794H20.1365L21.3366 11.2497H23.6982L22.1193 20.1056H2.148L1.33838 24.6524H25.9352L29.1383 6.70117H17.5191Z",
      fill: "currentColor",
    },
  ]
);

/** Google. */
export const GoogleLogo: IconData = brandMark(
  "translate(0.96 0.96) scale(0.46)",
  [
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
  ]
);

/** Microsoft. */
export const MicrosoftLogo: IconData = brandMark(
  "translate(1.92 1.92) scale(0.84)",
  [
    { d: "M0 0h11.408v11.408H0z", fill: "#F25022" },
    { d: "M12.594 0H24v11.408H12.594z", fill: "#7FBA00" },
    { d: "M0 12.594h11.408V24H0z", fill: "#00A4EF" },
    { d: "M12.594 12.594H24V24H12.594z", fill: "#FFB900" },
  ]
);

// The AI providers' own single-colour marks, unaltered, following the ink,
// at Simple Icons' weight on the grid (as Damsko's docs place them).

// Source: Simple Icons 16.36.0, anthropic.svg (CC0); follows the ink.
/** Anthropic. */
export const AnthropicLogo: IconData = brandMark(
  "translate(0.72 0.72) scale(0.94)",
  [
    {
      d: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
      fill: "currentColor",
    },
  ]
);

// Source: Simple Icons 13.21.0, openai.svg (CC0), as Damsko's docs vendor it; follows the ink.
/** OpenAI. */
export const OpenAiLogo: IconData = brandMark(
  "translate(0.72 0.72) scale(0.94)",
  [
    {
      d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
      fill: "currentColor",
    },
  ]
);

// Source: Simple Icons 16.36.0, mistralai.svg (CC0); its single-colour form, following the ink.
/** Mistral AI. */
export const MistralLogo: IconData = brandMark(
  "translate(0.72 0.72) scale(0.94)",
  [
    {
      d: "M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z",
      fill: "currentColor",
    },
  ]
);

// Source: Simple Icons 16.36.0, openrouter.svg (CC0); follows the ink.
/** OpenRouter. */
export const OpenRouterLogo: IconData = brandMark(
  "translate(0.72 0.72) scale(0.94)",
  [
    {
      d: "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z",
      fill: "currentColor",
    },
  ]
);

// Source: Simple Icons (CC0), HubSpot's sprocket in its own orange, as
// #2503's library drew it.
/** HubSpot. */
export const HubSpotLogo: IconData = brandMark(
  "translate(0.96 0.96) scale(0.92)",
  [
    {
      d: "M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z",
      fill: "#FF7A59",
    },
  ]
);
