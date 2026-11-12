import { cn } from "@grasp-os/ui/lib/utils";
import { SparklesIcon } from "lucide-react";
import type { ReactElement, SVGProps } from "react";

// The AI providers' marks, where a model is picked: from svgl
// (svgl.app, its shadcn registry), drawn in the text's own colour, as the
// kit's icons are, rather than each brand's. A provider without one of its
// own (an OpenAI-compatible endpoint) shows a spark.

type MarkProps = SVGProps<SVGSVGElement>;

const OpenAiMark = (props: MarkProps) => (
  // Cropped to the mark: svgl's square leaves a third of it empty round it.
  <svg {...props} fill="currentColor" viewBox="104 104 403 403">
    <path
      clipRule="evenodd"
      d="M252.794 108.802C289.191 99.0484 326.265 110.305 351.148 135.135C385.113 126.072 422.85 134.862 449.492 161.505C476.136 188.149 484.925 225.888 475.862 259.85V259.854C500.696 284.735 511.95 321.81 502.198 358.207C492.447 394.602 464.161 421.084 430.215 430.217C421.083 464.162 394.603 492.448 358.206 502.199C321.812 511.951 284.734 500.693 259.852 475.864C225.887 484.927 188.15 476.137 161.507 449.495C134.864 422.851 126.073 385.111 135.136 351.149C110.304 326.266 99.0496 289.192 108.801 252.795C118.552 216.4 146.84 189.918 180.784 180.785C189.917 146.841 216.396 118.553 252.794 108.802ZM374.292 407.145C374.292 411.271 372.092 415.086 368.517 417.148L283.723 466.102C302.487 480.585 327.555 486.459 352.217 479.852C386.997 470.532 410.068 439.312 410.555 405.006V317.717C410.555 315.08 409.125 312.621 406.843 311.303L374.292 292.509V407.145ZM251.868 415.897C248.296 417.959 243.893 417.959 240.317 415.897L155.526 366.942C152.366 390.436 159.811 415.08 177.866 433.136H177.863C203.325 458.594 241.896 462.962 271.85 446.232L347.449 402.586C349.735 401.268 351.148 398.8 351.148 396.163V358.579L251.868 415.897ZM368.602 220.628C366.319 219.309 363.474 219.318 361.191 220.637L328.641 239.431L427.921 296.749C431.496 298.811 433.697 302.627 433.697 306.752V404.661C455.622 395.654 473.244 376.881 479.851 352.218C489.169 317.442 473.668 281.85 444.201 264.274L368.602 220.628ZM177.303 206.34C155.377 215.348 137.756 234.122 131.148 258.783C121.832 293.561 137.331 329.153 166.799 346.727L242.398 390.373C244.68 391.692 247.525 391.684 249.807 390.366L282.357 371.572L183.078 314.253C179.504 312.189 177.303 308.375 177.303 304.251V206.34ZM259.849 279.145V331.858L305.5 358.213L351.15 331.858V279.145L305.5 252.789L259.849 279.145ZM327.276 144.9C308.512 130.418 283.445 124.543 258.782 131.15C224.002 140.471 200.931 171.691 200.445 205.995V293.286C200.445 295.923 201.875 298.381 204.158 299.7L236.707 318.493V203.856C236.707 199.731 238.909 195.916 242.483 193.853L327.276 144.9ZM433.137 177.867C407.675 152.407 369.103 148.038 339.149 164.769L263.55 208.415C261.265 209.734 259.852 212.202 259.852 214.838V252.423L359.132 195.105C362.703 193.041 367.108 193.041 370.682 195.105L455.473 244.06C458.635 220.567 451.189 195.922 433.135 177.867H433.137Z"
      fillRule="evenodd"
    />
  </svg>
);

const AnthropicMark = (props: MarkProps) => (
  <svg {...props} fill="currentColor" fillRule="evenodd" viewBox="0 0 24 24">
    <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z" />
  </svg>
);

const MistralMark = (props: MarkProps) => (
  <svg
    {...props}
    fill="currentColor"
    preserveAspectRatio="xMidYMid"
    viewBox="0 0 256 233"
  >
    <path d="M186.18 0h69.82v46.55h-69.82zM0 0h69.82v46.55H0zM0 46.55h116.36v46.54H0zM139.64 46.55H256v46.54H139.64zM0 93.09h256v46.55H0zM0 139.64h69.82v46.54H0zM93.09 139.64h69.82v46.54H93.09zM186.18 139.64H256v46.54h-69.82zM0 186.18h69.82v46.55H0zM186.18 186.18H256v46.55h-69.82z" />
  </svg>
);

const OpenRouterMark = (props: MarkProps) => (
  <svg
    {...props}
    fill="currentColor"
    stroke="currentColor"
    viewBox="0 0 512 512"
  >
    <path
      d="M3 248.945C18 248.945 76 236 106 219C136 202 136 202 198 158C276.497 102.293 332 120.945 423 120.945"
      fill="none"
      strokeWidth="90"
    />
    <path d="M511 121.5L357.25 210.268L357.25 32.7324L511 121.5Z" />
    <path
      d="M0 249C15 249 73 261.945 103 278.945C133 295.945 133 295.945 195 339.945C273.497 395.652 329 377 420 377"
      fill="none"
      strokeWidth="90"
    />
    <path d="M508 376.445L354.25 287.678L354.25 465.213L508 376.445Z" />
  </svg>
);

const marks: Record<string, (props: MarkProps) => ReactElement> = {
  openai: OpenAiMark,
  anthropic: AnthropicMark,
  mistral: MistralMark,
  openrouter: OpenRouterMark,
};

/** The mark of the provider that serves `model` (`provider/model`). */
export const ProviderMark = ({
  model,
  className,
}: {
  model: string;
  className?: string;
}) => {
  const [provider = ""] = model.split("/");
  const Mark = marks[provider];
  if (Mark === undefined) {
    return (
      <SparklesIcon aria-hidden className={cn("size-4 shrink-0", className)} />
    );
  }
  return <Mark aria-hidden className={cn("size-4 shrink-0", className)} />;
};
