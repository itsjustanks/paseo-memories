import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import { handleNoteAdd, handleNotePreview } from "./server/add-note";
import { handleClaudeCreate, handleClaudeDelete, handleClaudeUpdate } from "./server/claude-memory";
import { handleCodexWrite } from "./server/codex-memory";
import { handleInstructionWrite } from "./server/instructions";
import { runShutdown, runStart } from "./server/lifecycle";
import { logFailure, logSlow } from "./server/log";
import { markClientSeen } from "./server/presence";
import { handlePromptGet, handlePromptSet } from "./server/prompt";
import { handleAgentPlan, handleEntryBody, handleInventory, handleSourceDetail, handleWorkspacePlan } from "./server/read";
import { handleSearch } from "./server/search";
import {
  handleSkillDetail,
  handleSkillsAdd,
  handleSkillsAgent,
  handleSkillsCatalog,
  handleSkillsFix,
  handleSkillsFixAll,
  handleSkillsInventory,
  handleSkillsLink,
  handleSkillsPreview,
  handleSkillsRemove,
  handleSkillsToggle,
  handleSkillsUsage,
  handleSkillsWorkspace,
} from "./server/skill-handlers";
import { handleSidebarStatus } from "./server/sidebar-cache";
import { handleFindings } from "./server/tidy";
import { handleTidyFixAll } from "./server/tidy-fix";
import { handleExport, handleImportApply, handleImportParse, handleImportPreview } from "./server/transfer";
import {
  agentPlan,
  claudeMemoryCreate,
  claudeMemoryDelete,
  claudeMemoryUpdate,
  codexMemoryWrite,
  entryBody,
  exportMemories,
  findings,
  importApply,
  importParse,
  importPreview,
  instructionWrite,
  inventory,
  noteAdd,
  notePreview,
  promptGet,
  promptSet,
  search,
  sidebarStatus,
  sourceDetail,
  tidyFixAll,
  workspacePlan,
} from "./shared/contracts";
import { maskTextFields } from "./shared/secrets";
import { skillDetail, skillsAdd, skillsAgent, skillsCatalog, skillsFix, skillsFixAll, skillsInventory, skillsLink, skillsPreview, skillsRemove, skillsToggle, skillsUsage, skillsWorkspace } from "./shared/skill-contracts";
import { memoriesSettings } from "./shared/settings";
import { readMemoriesSettings, adoptSettingsHandle } from "./server/settings";
import { redactResult } from "./shared/redact";

/** Slow enough to be worth a line in the daemon log. */
const SLOW_RPC_MS = 5_000;

export default function contribute(server: PluginServerContext) {
  // Every RPC comes from a connected app: note it (background work rests
  // while nobody is looking, server/presence.ts), log the slow ones by name,
  // and log failures by name and error code only: never a message, which
  // could quote a memory.
  //
  // Every response has its secret-looking values masked here, in one place
  // (human text fields only: ids and paths go back to the host unchanged),
  // unless the request asked to reveal them (`reveal`) or the user turned
  // masking off. Handlers that reveal per item (export) or only hand back what
  // the app sent (import-parse) opt out and mask themselves.
  const handle = <I extends ZodType, O extends ZodType>(
    contract: PluginRpcContract<I, O>,
    handler: (input: ZodOutput<I>, context: PluginHandlerContext) => ZodInput<O> | Promise<ZodInput<O>>,
    { maskOutput = true, looking = true }: { maskOutput?: boolean; /** The call means someone is looking at a page (false: the sidebar's dot). */ looking?: boolean } = {},
  ) =>
    server.handle(contract, async (input, context) => {
      if (looking) markClientSeen();
      const began = Date.now();
      try {
        // Result messages never carry a key, whatever the settings say (0.6.0).
        const output = redactResult(await handler(input, context));
        const reveal = Boolean((input as { reveal?: unknown } | null)?.reveal);
        if (!maskOutput || reveal || !(await readMemoriesSettings()).maskSecrets) return output;
        return maskTextFields(output);
      } catch (error) {
        logFailure(contract.name, error);
        throw error;
      } finally {
        const ms = Date.now() - began;
        if (ms >= SLOW_RPC_MS) logSlow(contract.name, ms);
      }
    });

  // Paseo 0.9+ returns a live handle: settings changes apply without a reload.
  const stopSettings = adoptSettingsHandle(server.registerSettings(memoriesSettings));
  handle(inventory, handleInventory);
  handle(sourceDetail, handleSourceDetail);
  handle(entryBody, handleEntryBody);
  handle(workspacePlan, handleWorkspacePlan);
  handle(agentPlan, handleAgentPlan);
  handle(claudeMemoryCreate, handleClaudeCreate);
  handle(claudeMemoryUpdate, handleClaudeUpdate);
  handle(claudeMemoryDelete, handleClaudeDelete);
  handle(instructionWrite, handleInstructionWrite);
  handle(promptGet, handlePromptGet);
  handle(promptSet, handlePromptSet);
  handle(codexMemoryWrite, handleCodexWrite);
  handle(findings, handleFindings);
  handle(search, handleSearch);
  handle(importParse, handleImportParse, { maskOutput: false });
  handle(importPreview, handleImportPreview);
  handle(importApply, handleImportApply);
  handle(exportMemories, handleExport, { maskOutput: false });
  handle(notePreview, handleNotePreview);
  handle(noteAdd, handleNoteAdd);
  // 0.5.1: Fix all for Claude's list, and the sidebar dots' last known answer (a sidebar isn't someone looking at a page).
  handle(tidyFixAll, handleTidyFixAll);
  handle(sidebarStatus, handleSidebarStatus, { maskOutput: false, looking: false });
  // Skills (0.4.0).
  handle(skillsInventory, handleSkillsInventory);
  handle(skillDetail, handleSkillDetail);
  handle(skillsUsage, handleSkillsUsage);
  handle(skillsCatalog, handleSkillsCatalog);
  handle(skillsAgent, handleSkillsAgent);
  handle(skillsWorkspace, handleSkillsWorkspace);
  handle(skillsPreview, handleSkillsPreview);
  handle(skillsAdd, handleSkillsAdd);
  handle(skillsToggle, handleSkillsToggle);
  handle(skillsRemove, handleSkillsRemove);
  handle(skillsFix, handleSkillsFix);
  handle(skillsFixAll, handleSkillsFixAll);
  handle(skillsLink, handleSkillsLink);

  runStart();
  return () => {
    stopSettings();
    runShutdown();
  };
}
