// What the Discord adapter imports from discord.js, in its place in every
// admin build (vite.config.ts, vite.test.config.ts). The adapter uses
// discord.js only to hold Discord's Gateway open, which the admin never
// does: it answers over HTTP (src/admin/discord.ts). The real package
// can't be bundled for a Worker (its optional `zlib-sync` and CommonJS
// `require`s of Node's built-ins), and would add megabytes for nothing, so
// anything that does reach for the Gateway fails here, loudly.
const gateway = (): never => {
  throw new Error("The admin never opens Discord's Gateway.");
};

export class Client {
  readonly opened: never = gateway();
}
export const Events = {};
export const GatewayIntentBits = {};
export const Partials = {};
