// What Add connection is handed and hands back: its providers in groups, and the key once chosen.
import type { IconData } from "@grasp-os/ui/lib/icons";

/** One provider, as a tile. */
export interface AddConnectionProvider {
  /** A short, lasting id ("anthropic"). */
  id: string;
  /** Its name ("Anthropic"). */
  name: string;
  /** Where its calls go, the tile's muted line ("api.anthropic.com"). */
  host: string;
  /** Its mark, from the product's brands (frame/brands.ts). */
  logo?: IconData;
  /** For a provider with no brand mark (an endpoint of your own): an icon from the icons entry, in the same square (`Cable`). Without either, its first letter. */
  icon?: IconData;
  /** One is connected already: the tile ends in a quiet "Add another". */
  connected?: boolean;
  /**
   * What the tile opens: `key`, the key step in the sheet (the tile ends in a chevron); `host`, the
   * host's own way in (a sign-in), through `onSelect`, and the sheet closes.
   * @default "key"
   */
  opens?: "key" | "host";
  /** How its keys start, as the key field's placeholder ("sk-ant-…"). */
  keyHint?: string;
  /** Where its keys are made, linked from the key step. */
  keyUrl?: string;
  /** An endpoint of your own: the key step asks for its address first. */
  address?: boolean;
}

/** A group of tiles under its heading ("API keys"). Groups are data: as many as the host has. */
export interface AddConnectionGroup {
  id: string;
  label: string;
  providers: readonly AddConnectionProvider[];
}

/** What `onConnect` is handed: the provider, the key, the name given, and an endpoint's address. */
export interface AddConnectionChoice {
  provider: string;
  key: string;
  /** The name given, or "" when none was. */
  name: string;
  address?: string;
}

/** Where the key step stands: at rest, connecting, refused, or connected. */
export type AddConnectionStatus = "idle" | "working" | "refused" | "done";
