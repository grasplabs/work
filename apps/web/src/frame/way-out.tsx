import { Link, useLocation } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useState } from "react";

// Back in a section of the sidebar (Settings, the Brain, Integrations) leads
// out of every section, to the last page the main sidebar stood beside. Each
// section once kept the last page outside itself, so going from Settings to
// the Brain made Back in the Brain lead to Settings and Back there lead to
// the Brain again, never to the main sidebar. An App's and an agent's Back
// lead to their lists, which stand beside the main sidebar already.

/** A page the main sidebar stands beside, to go back to. */
interface Outside {
  pathname: string;
  search: Record<string, unknown>;
}

/** The sections whose pages put a sidebar of their own in place of the main one. */
const SECTIONED = [
  /^\/settings(?:\/|$)/u,
  /^\/brain(?:\/|$)/u,
  /^\/integrations(?:\/|$)/u,
  /^\/apps\/[^/]+/u,
  /^\/agents\/(?!new$)[^/]+/u,
];

const inSection = (pathname: string): boolean =>
  SECTIONED.some((section) => section.test(pathname));

/**
 * Where Back in a section leads: the last page outside every section, kept
 * while the frame is; Chat when the person landed in a section.
 */
export const useWayOut = (): ReactElement => {
  const { pathname, search } = useLocation();
  const [outside, setOutside] = useState<Outside>();
  if (!inSection(pathname) && outside?.pathname !== pathname) {
    setOutside({ pathname, search });
  }
  return outside === undefined ? (
    <Link to="/" />
  ) : (
    <Link search={outside.search} to={outside.pathname} />
  );
};
