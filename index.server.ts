import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import { handleClaudeCreate, handleClaudeDelete, handleClaudeUpdate } from "./server/claude-memory";
import { handleCodexWrite } from "./server/codex-memory";
import { handleInstructionWrite } from "./server/instructions";
import { runShutdown, runStart } from "./server/lifecycle";
import { logFailure, logSlow } from "./server/log";
import { markClientSeen } from "./server/presence";
import { handlePromptGet, handlePromptSet } from "./server/prompt";
import { handleAgentPlan, handleEntryBody, handleInventory, handleSourceDetail, handleWorkspacePlan } from "./server/read";
import { handleSearch } from "./server/search";
import { handleFindings } from "./server/tidy";
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
  promptGet,
  promptSet,
  search,
  sourceDetail,
  workspacePlan,
} from "./shared/contracts";
import { maskTextFields } from "./shared/secrets";
import { memoriesSettings } from "./shared/settings";
import { readMemoriesSettings } from "./server/settings";

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
    { maskOutput = true }: { maskOutput?: boolean } = {},
  ) =>
    server.handle(contract, async (input, context) => {
      markClientSeen();
      const began = Date.now();
      try {
        const output = await handler(input, context);
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

  server.registerSettings(memoriesSettings);
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

  runStart();
  return runShutdown;
}
