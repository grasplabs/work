// The areas with a navigation of their own, each a level of the sidebar
// (frame/sidebar.tsx) while one of its pages is open, in place of the main
// list, as the reference's (#2503's frame/way-out.tsx): Settings, the
// Brain, Integrations, one App, one agent. Back in a level leads out of
// every level (way-out.tsx), to a page none of these hold.

/** The pages that put a level of their own in place of the main list. */
const levels = [
  /^\/settings(?:\/|$)/u,
  /^\/brain(?:\/|$)/u,
  /^\/integrations(?:\/|$)/u,
  /^\/apps\/[^/]+/u,
  /^\/agents\/(?!new$)[^/]+/u,
];

/** Whether the page at `pathname` is in an area with a level of its own. */
export const inLevel = (pathname: string): boolean =>
  levels.some((level) => level.test(pathname));
