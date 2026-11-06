import { loadConfig } from "../config/load.js";
import { updateUserConfig } from "../config/write.js";
import { resolve } from "node:path";

export function normalizeProjectPath(projectDir: string): string {
  return resolve(projectDir);
}

function readExtensions(configPath?: string): {
  trustedProjects: string[];
  deniedProjects: string[];
} {
  const config = loadConfig(
    configPath ? { userConfigPath: configPath } : undefined,
  );
  return {
    trustedProjects: [...(config.extensions?.trustedProjects ?? [])],
    deniedProjects: [...(config.extensions?.deniedProjects ?? [])],
  };
}

export function isProjectTrusted(
  projectDir: string,
  configPath?: string,
): boolean {
  const normalized = normalizeProjectPath(projectDir);
  return readExtensions(configPath).trustedProjects.includes(normalized);
}

export function isProjectDenied(
  projectDir: string,
  configPath?: string,
): boolean {
  const normalized = normalizeProjectPath(projectDir);
  return readExtensions(configPath).deniedProjects.includes(normalized);
}

function writeDecision(
  projectDir: string,
  decision: "trusted" | "denied" | "none",
  configPath?: string,
): void {
  const normalized = normalizeProjectPath(projectDir);
  updateUserConfig((config) => {
    const extensions =
      config.extensions && typeof config.extensions === "object"
        ? (config.extensions as Record<string, unknown>)
        : {};
    const trusted = Array.isArray(extensions.trustedProjects)
      ? [...(extensions.trustedProjects as string[])]
      : [];
    const denied = Array.isArray(extensions.deniedProjects)
      ? [...(extensions.deniedProjects as string[])]
      : [];

    const without = (paths: string[]) =>
      paths.filter((path) => path !== normalized);

    extensions.trustedProjects =
      decision === "trusted"
        ? [...without(trusted), normalized]
        : without(trusted);
    extensions.deniedProjects =
      decision === "denied"
        ? [...without(denied), normalized]
        : without(denied);
    config.extensions = extensions;
  }, configPath);
}

export function trustProject(projectDir: string, configPath?: string): void {
  writeDecision(projectDir, "trusted", configPath);
}

export function denyProject(projectDir: string, configPath?: string): void {
  writeDecision(projectDir, "denied", configPath);
}

export function untrustProject(projectDir: string, configPath?: string): void {
  writeDecision(projectDir, "none", configPath);
}
