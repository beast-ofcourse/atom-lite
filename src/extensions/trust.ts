import { loadConfig } from "../config/load.js";
import { updateUserConfig } from "../config/write.js";
import { resolve } from "node:path";

export function normalizeProjectPath(projectDir: string): string {
  return resolve(projectDir);
}

export function isProjectTrusted(
  projectDir: string,
  configPath?: string,
): boolean {
  const config = loadConfig(
    configPath ? { userConfigPath: configPath } : undefined,
  );
  const normalized = normalizeProjectPath(projectDir);
  return (config.extensions?.trustedProjects ?? []).includes(normalized);
}

export function trustProject(projectDir: string, configPath?: string): void {
  const normalized = normalizeProjectPath(projectDir);
  updateUserConfig(
    (config) => {
      const extensions =
        config.extensions && typeof config.extensions === "object"
          ? (config.extensions as Record<string, unknown>)
          : {};
      const trusted = Array.isArray(extensions.trustedProjects)
        ? [...(extensions.trustedProjects as string[])]
        : [];
      if (!trusted.includes(normalized)) trusted.push(normalized);
      extensions.trustedProjects = trusted;
      config.extensions = extensions;
    },
    configPath,
  );
}

export function untrustProject(projectDir: string, configPath?: string): void {
  const normalized = normalizeProjectPath(projectDir);
  updateUserConfig(
    (config) => {
      const extensions =
        config.extensions && typeof config.extensions === "object"
          ? (config.extensions as Record<string, unknown>)
          : {};
      const trusted = Array.isArray(extensions.trustedProjects)
        ? (extensions.trustedProjects as string[]).filter(
            (path) => path !== normalized,
          )
        : [];
      extensions.trustedProjects = trusted;
      config.extensions = extensions;
    },
    configPath,
  );
}
