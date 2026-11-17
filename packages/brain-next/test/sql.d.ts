/** A migration, imported as its text (vite.config.ts). */
declare module "*.sql" {
  const text: string;
  export default text;
}
