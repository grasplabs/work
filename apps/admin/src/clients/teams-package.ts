/**
 * A client's Teams app package: the one file its IT uploads to Teams
 * (Teams admin center › Manage apps › Upload) to give its people Stephen.
 * A zip of the app's manifest (v1.19) and its two icons, made from the bot
 * staff set for the client (src/clients/teams-bot.ts) and the client's
 * name as the admin keeps it: nothing of any client is in this repo.
 *
 * The manifest offers the bot in private chats alone (`personal`): Stephen
 * answers one person at a time, and core turns a group chat or a channel
 * away anyway (core's src/channels/). It asks Teams for no permissions, no
 * tabs and no domains: everything he does goes through the bot.
 *
 * The icons are drawn here from the Grasp mark (src/admin/grasp-mark.tsx),
 * as Grasp's favicon colours it: the colour one 192 pixels square on
 * Grasp's green, the outline one 32 pixels square in white on transparent,
 * as Teams asks for each. Drawn rather than kept as images, so the
 * package is made from this file alone and the same bot always gets the
 * same bytes.
 */
import { toBase64Url } from "@grasp-os/shared/encoding";
import { eq } from "drizzle-orm";
import { strToU8, zipSync, zlibSync } from "fflate";

import type { AdminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { teamsBotOf } from "./teams-bot.ts";
import type { TeamsBot } from "./teams-bot.ts";

/** The manifest schema the package is written to. */
export const teamsManifestVersion = "1.19";

/**
 * The app's own version. Teams takes an upload over an app it has only
 * with a higher one: raise it whenever what the package says changes.
 */
const appVersion = "1.0.0";

/** Grasp's green, the colour icon's background and the app's accent. */
const accentColor = "#D9F9AD";

/** The mark's colour on Grasp's green: its dark green. */
const markColor = [0x06, 0x2d, 0x22] as const;

/** Grasp, as Teams shows who made the app. */
const developer = {
  name: "Grasp",
  websiteUrl: "https://joingrasp.com",
  privacyUrl: "https://joingrasp.com/privacy-policy",
  termsOfUseUrl: "https://joingrasp.com/terms-of-service",
} as const;

/** Teams' limits on the app's full name and short description. */
const fullNameLimit = 100;

/** The file the package downloads as, for client `clientId`. */
export const teamsPackageFileName = (clientId: string): string =>
  `stephen-teams-${clientId}.zip`;

/**
 * The app's manifest for client `clientName`'s bot `bot`: the bot's app
 * id as the app's own too, so the app and its bot are one in Teams and in
 * the client's Entra.
 */
export const teamsManifest = (bot: TeamsBot, clientName: string) => {
  const full = `Stephen for ${clientName}`;
  return {
    $schema: `https://developer.microsoft.com/en-us/json-schemas/teams/v${teamsManifestVersion}/MicrosoftTeams.schema.json`,
    manifestVersion: teamsManifestVersion,
    version: appVersion,
    id: bot.appId,
    developer,
    name: {
      short: "Stephen",
      full:
        full.length <= fullNameLimit
          ? full
          : `${full.slice(0, fullNameLimit - 1)}…`,
    },
    description: {
      short: "Help with your work, from what your company shared with Grasp.",
      full: "Stephen helps you with your work. Ask him anything in a private chat, and he answers from what your company shared with Grasp, with its sources. He never changes anything until you confirm it on a card.",
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor,
    bots: [
      {
        botId: bot.appId,
        scopes: ["personal"],
        supportsFiles: false,
        isNotificationOnly: false,
      },
    ],
    permissions: [],
    validDomains: [],
  };
};

/** A point of the mark, in its own units: x right, y down. */
type Point = readonly [number, number];

/**
 * The Grasp mark's four shapes, in its 82 × 68 box (src/admin/grasp-mark.tsx
 * draws the same paths): none overlaps another.
 */
const markShapes: readonly (readonly Point[])[] = [
  [
    [15.99, 0],
    [13.72, 12.51],
    [74.32, 12.51],
    [76.58, 0],
  ],
  [
    [42.21, 18.42],
    [5.59, 18.42],
    [3.33, 30.93],
    [39.94, 30.93],
  ],
  [
    [38.88, 36.85],
    [2.26, 36.85],
    [0, 49.36],
    [36.61, 49.36],
  ],
  [
    [48.84, 18.42],
    [43.23, 49.44],
    [56.14, 49.44],
    [59.48, 30.93],
    [66.07, 30.93],
    [61.67, 55.29],
    [5.98, 55.29],
    [3.73, 67.79],
    [72.31, 67.79],
    [81.24, 18.42],
  ],
];
const markWidth = 81.24;
const markHeight = 67.79;

/** Whether `point` is inside `shape` (even-odd). */
const inside = ([x, y]: Point, shape: readonly Point[]): boolean => {
  let within = false;
  for (let index = 0, previous = shape.length - 1; index < shape.length;) {
    const [xi, yi] = shape[index] ?? [0, 0];
    const [xj, yj] = shape[previous] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      within = !within;
    }
    previous = index;
    index += 1;
  }
  return within;
};

/** Samples per pixel along each axis, so the mark's slanted edges are smooth. */
const samples = 4;

/**
 * How much of each pixel of a `size`-pixel square the mark covers, from 0
 * to 1, the mark `markSize` pixels wide and centred.
 */
const markCoverage = (size: number, markSize: number): Float32Array => {
  const scale = markSize / markWidth;
  const left = (size - markWidth * scale) / 2;
  const top = (size - markHeight * scale) / 2;
  const coverage = new Float32Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const point: Point = [
            (column + (sx + 0.5) / samples - left) / scale,
            (row + (sy + 0.5) / samples - top) / scale,
          ];
          if (markShapes.some((shape) => inside(point, shape))) {
            hits += 1;
          }
        }
      }
      coverage[row * size + column] = hits / (samples * samples);
    }
  }
  return coverage;
};

/* oxlint-disable no-bitwise -- CRC-32 is 32-bit arithmetic */
/** CRC-32 (IEEE), as PNG's chunks carry it. */
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};
/* oxlint-enable no-bitwise */

/** A PNG chunk of `type` holding `data`. */
const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(strToU8(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

/** The PNG file's signature. */
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `rgba`, a `size`-pixel square, 8 bits a channel, as a PNG file. */
const png = (size: number, rgba: Uint8Array): Uint8Array => {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  // 8 bits a channel, truecolour with alpha; deflate, no filter, no interlace.
  header.set([8, 6, 0, 0, 0], 8);
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let row = 0; row < size; row += 1) {
    // Each row starts with its filter: none.
    raw.set(
      rgba.subarray(row * stride, (row + 1) * stride),
      row * (stride + 1) + 1
    );
  }
  const parts = [
    Uint8Array.from(pngSignature),
    chunk("IHDR", header),
    chunk("IDAT", zlibSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Teams' colour icon's size, and how wide the mark is drawn on it. */
const colorSize = 192;
const colorMark = 116;
/** Teams' outline icon's size, and how wide the mark is drawn on it. */
const outlineSize = 32;
const outlineMark = 28;

/** The colour icon: the mark in its dark green on Grasp's green, full bleed. */
export const colorIcon = (): Uint8Array => {
  const coverage = markCoverage(colorSize, colorMark);
  const background = [0xd9, 0xf9, 0xad] as const;
  const rgba = new Uint8Array(colorSize * colorSize * 4);
  for (const [pixel, covered] of coverage.entries()) {
    for (let channel = 0; channel < 3; channel += 1) {
      const under = background[channel] ?? 0;
      const over = markColor[channel] ?? 0;
      rgba[pixel * 4 + channel] = Math.round(under + (over - under) * covered);
    }
    rgba[pixel * 4 + 3] = 255;
  }
  return png(colorSize, rgba);
};

/** The outline icon: the mark in white, on transparent, as Teams asks. */
export const outlineIcon = (): Uint8Array => {
  const coverage = markCoverage(outlineSize, outlineMark);
  const rgba = new Uint8Array(outlineSize * outlineSize * 4);
  for (const [pixel, covered] of coverage.entries()) {
    rgba.set([255, 255, 255, Math.round(255 * covered)], pixel * 4);
  }
  return png(outlineSize, rgba);
};

/**
 * When every file in the package says it was made: fixed, so the same
 * bot and name always give the same file.
 */
const packageTime = new Date("2026-10-24T00:00:00Z");

/** Client `clientName`'s Teams app package for its bot `bot`: a zip. */
export const teamsPackage = (bot: TeamsBot, clientName: string): Uint8Array =>
  zipSync(
    {
      "manifest.json": strToU8(
        `${JSON.stringify(teamsManifest(bot, clientName), null, 2)}\n`
      ),
      "color.png": colorIcon(),
      "outline.png": outlineIcon(),
    },
    { mtime: packageTime }
  );

/** A client's Teams app package, as its page downloads it. */
export interface TeamsPackageDownload {
  fileName: string;
  /** The zip, base64url. */
  zip: string;
}

/**
 * Client `clientId`'s Teams app package, from its bot and its name as the
 * admin keeps them; null for no such client, or one without a bot.
 */
export const clientTeamsPackage = async (
  db: AdminDatabase,
  clientId: string
): Promise<TeamsPackageDownload | null> => {
  const [client] = await db
    .select({ name: clients.name, teamsBot: clients.teamsBot })
    .from(clients)
    .where(eq(clients.id, clientId));
  const bot = teamsBotOf(client?.teamsBot ?? null);
  if (client === undefined || bot === null) {
    return null;
  }
  return {
    fileName: teamsPackageFileName(clientId),
    zip: toBase64Url(teamsPackage(bot, client.name)),
  };
};
