import type { OAuthProvider } from "@grasp-os/shared/connect";
// The marks the product draws itself, other companies' own, in one module
// for the whole app: Grasp's own connectors (`brands`: core serves no logo
// for them, their `CatalogEntry.logo` is null, unlike a Composio
// toolkit's) and the makers of the models a question names that #2503
// marks, Anthropic and OpenAI (`makerMarks`: the model selector in the box
// to ask in, chat/composer.tsx). Each is picked only by an id that is
// exactly its own: a connector's, or the first part of a model's ID, its
// AI provider's (`anthropic/…`). Any other maker has no mark on the
// model's chip and Damsko's first-letter mark in its list. A name that
// starts like a brand's is not that brand: `openai-compatible` is not
// OpenAI.
// Each is filled and in the company's own colours, as the company
// publishes it, never a line redraw (Damsko draws no brands: its
// BrandIcon and ModelSelector take the product's, made with
// `filledMark`).
//
// A mark is a list of filled parts, its own grid placed on the 24 grid and
// sized by eye.
import { filledMark } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";

interface Part {
  d: string;
  fill: string;
  /** How a part with holes in it is filled. */
  rule?: "evenodd";
}

/** A brand's parts as drawing data, placed on the 24 grid by `transform` (none: drawn on it). */
const brandMark = (transform: string, parts: Part[]): IconData =>
  filledMark(
    parts.map(
      (part, index) =>
        [
          "path",
          {
            key: `part-${index}`,
            d: part.d,
            fill: part.fill,
            ...(part.rule === undefined
              ? {}
              : { fillRule: part.rule, clipRule: part.rule }),
            ...(transform === "" ? {} : { transform }),
          },
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

/** ChatGPT, for OpenAI. */
const BrandChatGpt: IconData = brandMark("translate(0.72 0.72) scale(0.94)", [
  {
    d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    fill: "currentColor",
  },
]);

/** Claude, for Anthropic. */
const BrandClaude: IconData = brandMark("translate(0.48 0.48) scale(0.96)", [
  {
    d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    fill: "#D97757",
  },
]);

/** Slack, a place people reach Stephen. */
const BrandSlack: IconData = brandMark("translate(0.72 0.72) scale(0.94)", [
  {
    d: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z",
    fill: "#E01E5A",
  },
  {
    d: "M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z",
    fill: "#36C5F0",
  },
  {
    d: "M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z",
    fill: "#2EB67D",
  },
  {
    d: "M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
    fill: "#ECB22E",
  },
]);

/** Microsoft Teams, a place people reach Stephen. */
const BrandTeams: IconData = brandMark("translate(0.48 0.48) scale(0.96)", [
  {
    d: "M21.25 3.6a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8zM19 8.75h5v5.5a3 3 0 0 1-3 3h-2z",
    fill: "#5059C9",
  },
  {
    d: "M16.5 2.15a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2zM13.75 8.75h6.75V15a4.5 4.5 0 0 1-6.75 3.9z",
    fill: "#7B83EB",
  },
  {
    d: "M1.25 5.5h10.5c.69 0 1.25.56 1.25 1.25v10.5c0 .69-.56 1.25-1.25 1.25H1.25C.56 18.5 0 17.94 0 17.25V6.75C0 6.06.56 5.5 1.25 5.5zM3 8.25h7V10H7.4v6.25H5.6V10H3z",
    fill: "#4B53BC",
    rule: "evenodd",
  },
  { d: "M3 8.25h7V10H7.4v6.25H5.6V10H3z", fill: "#FFFFFF" },
]);

/** The mark of each chat platform Stephen can be added to that the product has one for, by its id. */
export const placeMarks: Readonly<Record<string, IconData>> = {
  slack: BrandSlack,
  teams: BrandTeams,
};

/** The mark of each of Grasp's own connectors, by its id, and the name its company goes by. */
export const brands = {
  microsoft: { logo: BrandMicrosoft, name: "Microsoft" },
  google: { logo: BrandGoogle, name: "Google" },
} as const satisfies Record<OAuthProvider, { logo: IconData; name: string }>;

/** A connector with a mark of its own. */
export type Brand = keyof typeof brands;

/** The mark of each AI provider the product has one for, by its id exactly. */
const makerMarks: Readonly<Record<string, IconData>> = {
  anthropic: BrandClaude,
  openai: BrandChatGpt,
};

/** The product's own mark for the maker `id` (a model ID's first part), only when it is exactly one it has. */
export const makerMark = (id: string): IconData | undefined =>
  Object.hasOwn(makerMarks, id) ? makerMarks[id] : undefined;
