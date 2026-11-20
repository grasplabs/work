// Code: its lines, highlighted in the Worker, numbered, never wrapped (it scrolls sideways).
"use client";

import type { RendererProps } from "../../types";
import { Lines } from "../text/lines";

const CodeRenderer = (props: RendererProps) => (
  <Lines {...props} highlight wrap={false} />
);

export default CodeRenderer;
