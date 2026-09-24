import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import React, { useMemo } from "react";
import { Text } from "react-native";
import { memoriesSettings, type MemoriesSettings } from "../shared/settings";

/** The plugin's host settings (paseo-mcp `client/settings.tsx` pattern). */

const BACKUPS = [5, 10, 20, 50, 100].map((value) => ({ label: `${value} per file`, value: String(value) }));

export function MemoriesSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(memoriesSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") return <Text style={style}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Memories">
        <Text style={style}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} /> : null}
      </SettingsSection>
    );
  }
  const save = (patch: Partial<MemoriesSettings>) => void settings.save({ ...settings.values, ...patch }, settings.revision);
  const { values } = settings;
  return (
    <SettingsSection title="Memories">
      <SettingsCard>
        <SettingsSwitch label="Show technical details" hint="Off: plain names and notes. On: file names, paths, sizes and the whole-file editors" value={values.technicalDetails} disabled={settings.saving} onValueChange={(technicalDetails) => save({ technicalDetails })} />
        <SettingsSwitch label="Show other agents" hint="OpenCode, pi, Oh My Pi and Copilot files next to Claude and Codex" value={values.showOtherAgents} disabled={settings.saving} onValueChange={(showOtherAgents) => save({ showOtherAgents })} />
        <SettingsSwitch label="Check for stale mentions" hint="Paths and code names a memory mentions that no longer exist (code names are checked in the background while the app is open)" value={values.staleChecks} disabled={settings.saving} onValueChange={(staleChecks) => save({ staleChecks })} />
        <SettingsSwitch label="Hide secrets" hint="Token-looking values stay hidden until you reveal them" value={values.maskSecrets} disabled={settings.saving} onValueChange={(maskSecrets) => save({ maskSecrets })} />
        <SettingsSwitch label="Allow Codex memory edits" hint="Edits to Codex's MEMORY.md and memory_summary.md; Codex folds them in at its next run" value={values.codexEdits} disabled={settings.saving} onValueChange={(codexEdits) => save({ codexEdits })} />
        <SettingsSelect label="Backups kept" hint="Old copies kept per file under Paseo's plugin-data folder" value={String(values.backupsToKeep)} options={BACKUPS} disabled={settings.saving} onValueChange={(value) => save({ backupsToKeep: Number(value) })} />
      </SettingsCard>
    </SettingsSection>
  );
}
