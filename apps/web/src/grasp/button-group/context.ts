// The group's height and direction, read by its parts so every button matches.
"use client";

import { createContext, useContext } from "react";

import type { ButtonSize } from "../button";

export type ButtonGroupOrientation = "horizontal" | "vertical";

export const GroupContext = createContext<{
  size: ButtonSize;
  orientation: ButtonGroupOrientation;
}>({
  size: "md",
  orientation: "horizontal",
});

export const useGroup = () => useContext(GroupContext);
