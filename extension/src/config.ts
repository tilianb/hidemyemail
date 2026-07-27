export type ExtensionConfig = { server: string; key: string };
export const KEY_PATTERN = /^hme_[A-Za-z0-9_-]+$/;
export const STORAGE_ERROR = "Secure extension storage is unavailable. Reopen the popup or check Chrome extension settings.";
export const RECOVERY_ERROR = "Extension configuration could not be safely restored. Reopen the popup, review site access, and reconnect.";
export const PERMISSION_ERROR = "Site access could not be verified. Review extension site access and try again.";
export class ConfigError extends Error {}

export interface ConfigPlatform {
  get(): Promise<Partial<ExtensionConfig>>;
  set(value: ExtensionConfig): Promise<void>;
  clear(): Promise<void>;
  contains(originPattern: string): Promise<boolean>;
  request(originPattern: string): Promise<boolean>;
  remove(originPattern: string): Promise<boolean>;
}

export function canonicalizeServerUrl(input: string): string {
  try {
    const url = new URL(input.trim());
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new ConfigError("Enter a valid HTTPS server origin (HTTP is allowed only for localhost, 127.0.0.1, or ::1).");
  }
}

export function hostPermissionPattern(server: string): string {
  const url = new URL(server);
  return `${url.protocol}//${url.hostname}/*`;
}

function storedConfig(value: Partial<ExtensionConfig>): ExtensionConfig | null {
  if (typeof value.server !== "string" || typeof value.key !== "string" || !KEY_PATTERN.test(value.key)) return null;
  try {
    return canonicalizeServerUrl(value.server) === value.server ? { server: value.server, key: value.key } : null;
  } catch {
    return null;
  }
}

export async function configure(
  platform: ConfigPlatform,
  serverInput: string,
  key: string,
  validate: (candidate: ExtensionConfig) => Promise<void>,
): Promise<ExtensionConfig> {
  const server = canonicalizeServerUrl(serverInput);
  if (!KEY_PATTERN.test(key)) throw new ConfigError("Enter a dedicated API key beginning with hme_.");
  const next = { server, key };
  let previous: ExtensionConfig | null;
  try {
    const stored = await platform.get();
    previous = storedConfig(stored);
    if (!previous && (stored.server !== undefined || stored.key !== undefined)) await platform.clear();
  } catch {
    throw new ConfigError(STORAGE_ERROR);
  }
  const candidatePattern = hostPermissionPattern(server);
  const oldPattern = previous ? hostPermissionPattern(previous.server) : null;
  let hadCandidatePermission: boolean;
  try {
    hadCandidatePermission = await platform.contains(candidatePattern);
  } catch {
    throw new ConfigError(PERMISSION_ERROR);
  }
  const newlyGranted = !hadCandidatePermission;
  if (newlyGranted) {
    try {
      if (!(await platform.request(candidatePattern))) throw new ConfigError("Site access was denied. Allow access to connect this deployment.");
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      if (candidatePattern !== oldPattern) {
        try {
          if (!(await platform.remove(candidatePattern))) throw new ConfigError(RECOVERY_ERROR);
        } catch {
          throw new ConfigError(RECOVERY_ERROR);
        }
      }
      throw new ConfigError(PERMISSION_ERROR);
    }
  }

  const revokeCandidate = async (): Promise<boolean> => {
    if (!newlyGranted || candidatePattern === oldPattern) return true;
    try { return await platform.remove(candidatePattern); }
    catch { return false; }
  };
  try {
    await validate(next);
  } catch (error) {
    if (!(await revokeCandidate())) throw new ConfigError(RECOVERY_ERROR);
    throw error;
  }

  const serverChanged = Boolean(previous && previous.server !== server);
  const permissionChanged = serverChanged && oldPattern !== candidatePattern;
  try {
    await platform.set(next);
  } catch {
    if (!(await revokeCandidate())) throw new ConfigError(RECOVERY_ERROR);
    throw new ConfigError(STORAGE_ERROR);
  }

  if (permissionChanged && oldPattern) {
    let removed = false;
    try { removed = await platform.remove(oldPattern); } catch { /* handled below */ }
    if (!removed) {
      if (!previous) throw new ConfigError(RECOVERY_ERROR);
      try { await platform.set(previous); }
      catch { throw new ConfigError(RECOVERY_ERROR); }
      if (!(await revokeCandidate())) throw new ConfigError(RECOVERY_ERROR);
      throw new ConfigError("Could not remove previous site access. Your existing connection was retained.");
    }
  }
  return next;
}

export const chromePlatform: ConfigPlatform = {
  async get() { return chrome.storage.local.get(["server", "key"]); },
  async set(value) { await chrome.storage.local.set(value); },
  async clear() { await chrome.storage.local.remove(["server", "key"]); },
  async contains(origin) { return chrome.permissions.contains({ origins: [origin] }); },
  async request(origin) { return chrome.permissions.request({ origins: [origin] }); },
  async remove(origin) { return chrome.permissions.remove({ origins: [origin] }); },
};

export async function initializeStorage(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

export async function initializeConfig(
  platform: Pick<ConfigPlatform, "get" | "clear">,
  initialize: () => Promise<void> = initializeStorage,
): Promise<{ ok: true; config: Partial<ExtensionConfig> } | { ok: false; error: string }> {
  try {
    await initialize();
    const stored = await platform.get();
    const config = storedConfig(stored);
    if (!config && (stored.server !== undefined || stored.key !== undefined)) await platform.clear();
    return { ok: true, config: config ?? {} };
  } catch {
    return { ok: false, error: STORAGE_ERROR };
  }
}
