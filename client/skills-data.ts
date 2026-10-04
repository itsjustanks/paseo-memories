import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { skillDetail, skillsCatalog, skillsInventory, skillsUsage } from "../shared/skill-contracts";
import { KEY } from "./freshness";

/**
 * The Skills screen's queries. Reads only: they never wait for the usage
 * count or reach the network (the host answers from what it has), so every
 * visit asks again. Writes call `useSkillsRefresh` afterwards.
 */

const SKILLS = "skills";

export function useSkillsInventory(hostId: string) {
  const call = useRpc(skillsInventory);
  return useQuery({
    queryKey: [KEY, hostId, SKILLS, "inventory"],
    queryFn: () => call({}),
    retry: 1,
    refetchOnMount: "always",
    // While usage is being counted for the first time, look again shortly.
    refetchInterval: (query) => (query.state.data && (query.state.data.usage.state === "waiting" || query.state.data.usage.state === "checking") ? 10_000 : false),
  });
}

export function useSkillDetail(hostId: string, skillId: string | null, reveal = false) {
  const call = useRpc(skillDetail);
  return useQuery({ queryKey: [KEY, hostId, SKILLS, "detail", skillId, reveal], queryFn: () => call({ skillId: skillId!, ...(reveal ? { reveal } : {}) }), enabled: Boolean(skillId), retry: 1, refetchOnMount: "always" });
}

export function useSkillsUsage(hostId: string, days: number) {
  const call = useRpc(skillsUsage);
  return useQuery({ queryKey: [KEY, hostId, SKILLS, "usage", days], queryFn: () => call({ days }), retry: 1, refetchOnMount: "always" });
}

export function useSkillsCatalog(hostId: string) {
  const call = useRpc(skillsCatalog);
  return useQuery({ queryKey: [KEY, hostId, SKILLS, "catalog"], queryFn: () => call({}), retry: 1, refetchOnMount: "always" });
}

/** After an add, turn off or remove: everything Skills shows is out of date. */
export function useSkillsRefresh(hostId: string) {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: [KEY, hostId, SKILLS] });
}
