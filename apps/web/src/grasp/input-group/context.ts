// The group's height, read by its parts so the words, the button and the clear square line up.
"use client";

import { createContext, useContext } from "react";

export type InputGroupSize = "md" | "lg";

export const SizeContext = createContext<InputGroupSize>("md");

export const useGroupSize = () => useContext(SizeContext);
