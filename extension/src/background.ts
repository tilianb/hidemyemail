import { createApi } from "./api";
import { chromePlatform, initializeConfig, initializeStorage, type ExtensionConfig } from "./config";
import { handleContentMessage } from "./messages";

void initializeStorage().catch(() => undefined);
chrome.runtime.onInstalled.addListener(() => { void initializeStorage().catch(() => undefined); });

async function loadConfig(): Promise<ExtensionConfig | null> {
  const initialized = await initializeConfig(chromePlatform);
  return initialized.ok && initialized.config.server && initialized.config.key ? initialized.config as ExtensionConfig : null;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void handleContentMessage(message, sender, {
    extensionId: chrome.runtime.id,
    loadConfig,
    domains: (config) => createApi(config).domains(),
    destinations: (config) => createApi(config).destinations(),
    createRich: (config, input) => createApi(config).createAlias(input),
    list: (config, search) => createApi(config).listAliases(search),
    activate: async (config, id) => { await createApi(config).activateAlias(id); },
    deactivate: (config, id) => createApi(config).deactivateAlias(id),
    delete: (config, id) => createApi(config).deleteAlias(id),
  }).then(sendResponse);
  return true;
});
