// What the Discord adapter imports from discord.js, for the console's tests
// (vite.test.config.ts): only its Gateway listener uses them, which the
// console never starts, so anything that does fails the test.
const gateway = (): never => {
  throw new Error("The console never opens Discord's Gateway.");
};

export class Client {
  readonly opened: never = gateway();
}
export const Events = {};
export const GatewayIntentBits = {};
export const Partials = {};
