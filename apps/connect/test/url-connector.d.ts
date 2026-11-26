// The code of a connector made from a URL, its fields placeholders, as
// global-setup.ts builds it into dist/test/ and vite.config.ts aliases it.

declare module "#test-url-connector" {
  const code: string;
  export default code;
}
