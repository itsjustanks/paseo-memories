import { createContext, useContext } from "react";

/** Plain (true, the default) or technical. Provided by `ModeProvider` in client/mode.tsx. */
export const PlainContext = createContext(true);

export function usePlain(): boolean {
  return useContext(PlainContext);
}
