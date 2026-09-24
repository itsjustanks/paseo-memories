import { useSettings } from "@getpaseo/plugin/client";
import React, { useMemo } from "react";
import type { Account, Source } from "../shared/contracts";
import { plainSourceName } from "../shared/plain";
import { memoriesSettings } from "../shared/settings";
import { useInventory, useWorkspaceFolders } from "./data";
import { PlainContext } from "./plain-context";

/**
 * Plain or technical. "Show technical details" off (the default) shows plain
 * names and notes; on shows the file view as it was in 0.1. Every view asks
 * `usePlain()`; the surface and panels provide it from the host setting.
 */

export { usePlain } from "./plain-context";

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const settings = useSettings(memoriesSettings);
  // Until the setting is read (or when it can't be), plain.
  const technical = settings.status === "ready" ? Boolean((settings.values as { technicalDetails?: boolean }).technicalDetails) : false;
  return <PlainContext.Provider value={!technical}>{children}</PlainContext.Provider>;
}

/** Project folder → the name a person knows it by: the Paseo workspace's, else the folder's. */
export function projectNamer(workspaces: Array<{ name: string; path: string }>) {
  return (path: string) => {
    const hit = workspaces.find((entry) => entry.path === path) ?? workspaces.find((entry) => path.startsWith(`${entry.path}/`) || entry.path.startsWith(`${path}/`));
    return hit?.name || path.split("/").filter(Boolean).pop() || path;
  };
}

/** One name per source, the same in every view. */
export function useSourceNames(hostId: string) {
  const inventory = useInventory(hostId);
  const workspaces = useWorkspaceFolders(hostId);
  return useMemo(() => {
    const sources = inventory.data?.sources ?? [];
    const accounts: Account[] = inventory.data?.accounts ?? [];
    const namer = projectNamer(workspaces.data ?? []);
    const name = (source: Source) => plainSourceName(source, accounts, namer);
    const byId = (id: string) => {
      const source = sources.find((entry) => entry.id === id);
      return source ? name(source) : "a note";
    };
    return { name, byId, namer };
  }, [inventory.data, workspaces.data]);
}
