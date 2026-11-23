import { colors } from "@grasp-os/ui/lib/tokens.stylex";
// useMarkTint: the colour of a mark (an app's logo), for the texture behind its head. It draws the
// image small on a canvas and takes its dominant colour that is not a grey: the hue most of its
// coloured pixels share, averaged. A mark that is all greys (black, white, Notion's) has none, and so
// does an image the canvas may not read (another origin without CORS): then, and while it loads, it
// returns the neutral grey (`neutralTint`). Without a source it returns undefined, and the texture
// keeps its own mint. It is read once per source, after the page is in the browser.
//
//   const tint = useMarkTint("/logos/hubspot.svg");      // "rgb(255 122 89)", or the neutral grey
//   <PageHeader variant="banner" accentColor={tint} … />
import { useEffect, useState } from "react";

/** The tint of a mark with no colour of its own, or one that cannot be read: the quiet grey. */
export const neutralTint: string = colors.mutedForeground;

/** How small the mark is drawn to be read: enough for its colours, cheap to count. */
const SIDE = 32;
/** How far from grey a pixel must be (its channels' spread, of 255) to count as coloured. */
const COLOURED = 48;
/** The hue's buckets: twelve, 30 degrees each. */
const BUCKETS = 12;
/** The least share of the mark's seen pixels that must be coloured, else it is taken for grey. */
const LEAST = 0.06;

/** A pixel's hue, 0 to 360, from its channels. */
const hueOf = (red: number, green: number, blue: number) => {
  const high = Math.max(red, green, blue);
  const spread = high - Math.min(red, green, blue);
  if (spread === 0) {
    return 0;
  }
  if (high === red) {
    return (60 * ((green - blue) / spread) + 360) % 360;
  }
  if (high === green) {
    return 60 * ((blue - red) / spread) + 120;
  }
  return 60 * ((red - green) / spread) + 240;
};

interface Bucket {
  weight: number;
  red: number;
  green: number;
  blue: number;
}

/** The mark's dominant colour that is not grey, from its pixels (RGBA, four bytes each). */
export const dominantColour = (
  pixels: Uint8ClampedArray
): string | undefined => {
  const buckets: Bucket[] = Array.from({ length: BUCKETS }, () => ({
    weight: 0,
    red: 0,
    green: 0,
    blue: 0,
  }));
  let seen = 0;
  let coloured = 0;
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    const red = pixels[at] ?? 0;
    const green = pixels[at + 1] ?? 0;
    const blue = pixels[at + 2] ?? 0;
    const alpha = pixels[at + 3] ?? 0;
    if (alpha < 128) {
      continue;
    }
    seen += 1;
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
    if (spread < COLOURED) {
      continue;
    }
    coloured += 1;
    const bucket =
      buckets[Math.floor(hueOf(red, green, blue) / (360 / BUCKETS)) % BUCKETS];
    if (bucket !== undefined) {
      // A more vivid pixel counts for more: the brand's colour, not its shading.
      bucket.weight += spread;
      bucket.red += red * spread;
      bucket.green += green * spread;
      bucket.blue += blue * spread;
    }
  }
  if (seen === 0 || coloured / seen < LEAST) {
    return undefined;
  }
  let top = buckets[0] ?? { weight: 0, red: 0, green: 0, blue: 0 };
  for (const bucket of buckets) {
    if (bucket.weight > top.weight) {
      top = bucket;
    }
  }
  return `rgb(${Math.round(top.red / top.weight)} ${Math.round(top.green / top.weight)} ${Math.round(top.blue / top.weight)})`;
};

/** The image's dominant colour, or undefined where the canvas may not read it. */
const sample = (image: HTMLImageElement) => {
  const canvas = document.createElement("canvas");
  canvas.width = SIDE;
  canvas.height = SIDE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let colour: string | undefined;
  if (context !== null) {
    context.drawImage(image, 0, 0, SIDE, SIDE);
    try {
      colour = dominantColour(context.getImageData(0, 0, SIDE, SIDE).data);
    } catch {
      // Another origin without CORS taints the canvas: no colour of its own, the neutral grey.
    }
  }
  return colour;
};

/** The colour of a mark at `src`, for its head's texture: its own, else the neutral grey; undefined with no `src`. */
export const useMarkTint = (src: string | undefined): string | undefined => {
  const [tint, setTint] = useState<{
    src: string;
    colour: string | undefined;
  }>();
  useEffect(() => {
    if (src === undefined || src === "") {
      return () => {
        // Nothing was loaded, so nothing stops.
      };
    }
    let live = true;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.addEventListener("load", () => {
      if (live) {
        setTint({ src, colour: sample(image) });
      }
    });
    image.addEventListener("error", () => {
      if (live) {
        setTint({ src, colour: neutralTint });
      }
    });
    image.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  if (src === undefined || src === "") {
    return undefined;
  }
  // A colour read for another source is not this one's: until this one is read, the neutral grey.
  return (
    (tint !== undefined && tint.src === src ? tint.colour : undefined) ??
    neutralTint
  );
};
