import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ExtensionCompatibilityError } from "./compatibility-error.js";

/** Store schema version used when an extension registers no explicit version. */
export const EXTENSION_STORE_VERSION = 1;

/** Maximum serialized size of one extension's store file. */
export const EXTENSION_STORE_MAX_BYTES = 1024 * 1024;

interface ExtensionStoreFile {
  version: number;
  value: Record<string, unknown>;
}

export interface ExtensionStoreInfo {
  entryCount: number;
  version: number;
}

export interface ExtensionStoreOptions {
  id: string;
  agentDir: string;
}

/**
 * A durable key/value store scoped to one extension.
 *
 * State lives at `<agentDir>/extension-state/<id>.json` so it survives both
 * session deletion and reloads. The file is `{ version, value }`; `value` is a
 * JSON object keyed by the extension's own keys. An extension declares its
 * schema with `version` and `migrate` before it reads or writes state; the host
 * runs the migration once at activation.
 */
export class ExtensionStore {
  readonly id: string;
  readonly filePath: string;
  /** Schema version this extension understands. Set before reading or writing. */
  version = EXTENSION_STORE_VERSION;
  /** Transform an older `{ version, value }` payload to the registered version. */
  migrate?: (
    oldVersion: number,
    value: unknown,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;

  private data: ExtensionStoreFile = {
    version: EXTENSION_STORE_VERSION,
    value: {},
  };
  private activated = false;

  constructor(options: ExtensionStoreOptions) {
    this.id = options.id;
    this.filePath = join(
      options.agentDir,
      "extension-state",
      `${options.id}.json`,
    );
  }

  get(key: string): unknown {
    this.ensureActivated();
    return this.data.value[key];
  }

  set(key: string, value: unknown): void {
    this.ensureActivated();
    const next: ExtensionStoreFile = {
      version: this.version,
      value: { ...this.data.value, [key]: value },
    };
    this.write(next, "store.set");
    this.data = next;
  }

  delete(key: string): boolean {
    this.ensureActivated();
    if (!Object.hasOwn(this.data.value, key)) return false;
    const value = { ...this.data.value };
    delete value[key];
    const next: ExtensionStoreFile = { version: this.version, value };
    this.write(next, "store.set");
    this.data = next;
    return true;
  }

  /**
   * Load persisted state and run a pending migration once. A file written by a
   * newer schema version fails loudly instead of silently losing keys.
   */
  activate(): void {
    if (this.activated) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = { version: this.version, value: {} };
        this.activated = true;
        return;
      }
      throw this.compatibilityError(
        "store.activate",
        `cannot read the store file: ${(error as Error).message}`,
      );
    }

    let stored: ExtensionStoreFile;
    try {
      const parsed = JSON.parse(raw) as ExtensionStoreFile;
      if (
        !parsed ||
        !Number.isInteger(parsed.version) ||
        !parsed.value ||
        typeof parsed.value !== "object" ||
        Array.isArray(parsed.value)
      ) {
        throw new Error("expected { version, value } with an object value");
      }
      stored = parsed;
    } catch (error) {
      throw this.compatibilityError(
        "store.activate",
        `store file is invalid: ${(error as Error).message}`,
      );
    }

    if (stored.version > this.version) {
      throw this.compatibilityError(
        "store.migrate",
        `stored version ${stored.version} is newer than registered version ${this.version}`,
      );
    }

    this.data = stored;
    this.activated = true;
    if (stored.version === this.version) return;

    if (!this.migrate) {
      this.activated = false;
      throw this.compatibilityError(
        "store.migrate",
        `stored version ${stored.version} needs a migrate hook for version ${this.version}`,
      );
    }
    let migrated: Record<string, unknown>;
    try {
      const result = this.migrate(stored.version, stored.value);
      // A migration hook is synchronous: the host must finish activation before
      // the extension can use the store, so an async hook is a config error.
      if (result && typeof (result as Promise<unknown>).then === "function") {
        throw new Error("migrate hook must be synchronous");
      }
      migrated = result as Record<string, unknown>;
      if (
        !migrated ||
        typeof migrated !== "object" ||
        Array.isArray(migrated)
      ) {
        throw new Error("migrate hook must return an object");
      }
    } catch (error) {
      this.activated = false;
      throw this.compatibilityError(
        "store.migrate",
        `migration failed: ${(error as Error).message}`,
      );
    }
    const next: ExtensionStoreFile = { version: this.version, value: migrated };
    this.write(next, "store.migrate");
    this.data = next;
  }

  /** Entry count and schema version only — never the stored values. */
  info(): ExtensionStoreInfo {
    this.ensureActivated();
    return {
      entryCount: Object.keys(this.data.value).length,
      version: this.data.version,
    };
  }

  /** Archive on unregister/uninstall. A later archive replaces the old one. */
  archive(): void {
    if (!existsSync(this.filePath)) {
      this.data = { version: this.version, value: {} };
      this.activated = true;
      return;
    }
    const backup = `${this.filePath}.bak`;
    try {
      unlinkSync(backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(this.filePath, backup);
    this.data = { version: this.version, value: {} };
    this.activated = true;
  }

  private ensureActivated(): void {
    if (!this.activated) this.activate();
  }

  private write(data: ExtensionStoreFile, method: string): void {
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized, "utf8") > EXTENSION_STORE_MAX_BYTES) {
      throw this.compatibilityError(
        method,
        `value exceeds the ${EXTENSION_STORE_MAX_BYTES} byte store cap`,
        "store less data or use multiple extensions",
      );
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, serialized, "utf8");
  }

  private compatibilityError(
    method: string,
    reason: string,
    alternative?: string,
  ): ExtensionCompatibilityError {
    return new ExtensionCompatibilityError({
      method,
      tier: 1,
      reason,
      alternative,
    });
  }
}
