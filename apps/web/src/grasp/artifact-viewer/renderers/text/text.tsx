// Plain text: its lines, wrapped to the width, numbered.
"use client";

import type { RendererProps } from "../../types";
import { Lines } from "./lines";

const TextRenderer = (props: RendererProps) => (
  <Lines {...props} highlight={false} wrap />
);

export default TextRenderer;
