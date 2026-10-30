import type { RegionId } from "./brain-atlas.ts";

// Apart from brain-atlas.ts, which the brain page's address reads with this
// before the page loads: the atlas and the brain it's drawn from come with
// the page, not with the app.

/** Every region, as the type names them: a new one fails to compile until it's here. */
const regions: Record<RegionId, true> = {
  vision: true,
  teams: true,
  gaps: true,
  tools: true,
  workflows: true,
  sources: true,
};

export const isRegion = (value: unknown): value is RegionId =>
  typeof value === "string" && Object.hasOwn(regions, value);
