import type { Env } from "../types";
import { getEnvWithOverride } from "./settings";
import { sendRaw, SesPermanentError, SesRetryableError, SesTransientError, SesUncertainError } from "./ses";

export interface MailMessage {
  from: string;
  to: string;
  rawBase64: string;
  feedbackForwarding?: string;
}

export class MailRetryableError extends Error {}
export class MailPermanentError extends Error {}
export class MailUncertainError extends MailRetryableError {}

export type MailProviderConfig =
  | { provider: "ses"; accessKeyId: string; secretAccessKey: string; region: string }
  | { provider: "smtp" };

export async function resolveMailProviderConfig(
  db: D1Database,
  env: Env,
): Promise<MailProviderConfig | null> {
  const provider = (await getEnvWithOverride(db, env, "mail_outbound_provider") || "ses").trim().toLowerCase();
  if (provider === "ses") {
    const [accessKeyId, secretAccessKey, region] = await Promise.all([
      getEnvWithOverride(db, env, "ses_access_key_id"),
      getEnvWithOverride(db, env, "ses_secret_access_key"),
      getEnvWithOverride(db, env, "ses_region"),
    ]);
    return accessKeyId && secretAccessKey && region
      ? { provider, accessKeyId, secretAccessKey, region }
      : null;
  }
  if (provider !== "smtp") throw new MailPermanentError(`Unsupported MAIL_OUTBOUND_PROVIDER: ${provider}`);
  if (!env.SMTP_TRANSPORT) {
    throw new MailRetryableError("MAIL_OUTBOUND_PROVIDER=smtp requires the Docker-only SMTP_TRANSPORT binding");
  }
  return { provider };
}

export async function sendMail(
  db: D1Database,
  env: Env,
  message: MailMessage,
  resolvedConfig?: MailProviderConfig,
): Promise<{ providerId?: string }> {
  const injected = (env as any).__mailSend as ((message: MailMessage) => Promise<{ providerId?: string }>) | undefined;
  if (injected) return injected(message);

  const config = resolvedConfig ?? await resolveMailProviderConfig(db, env);
  if (!config) throw new MailRetryableError("Email sending is not configured");
  if (config.provider === "ses") {
    const ses = (env as any).__sesSend ?? sendRaw;
    try {
      const providerId = await ses({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        region: config.region,
      }, message);
      return { providerId };
    } catch (error) {
      if (error instanceof SesUncertainError) throw new MailUncertainError(error.message);
      if (error instanceof SesRetryableError) throw new MailRetryableError(error.message);
      // Legacy injected seams used SesTransientError for timeout/network loss.
      if (error instanceof SesTransientError) throw new MailUncertainError(error.message);
      if (error instanceof SesPermanentError) throw new MailPermanentError(error.message);
      throw error;
    }
  }

  const transport = env.SMTP_TRANSPORT;
  if (!transport) throw new MailRetryableError("SMTP transport binding is unavailable");
  let response: Response;
  try {
    response = await transport.fetch("http://smtp.internal/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch (error) {
    throw new MailUncertainError(`SMTP transport response lost: ${String(error)}`);
  }
  if (response.ok) {
    const body = await response.json<{ providerId?: string }>().catch(() => ({}));
    return body;
  }
  const detail = (await response.text()).slice(0, 500);
  if (response.status === 504) throw new MailUncertainError(`SMTP acceptance uncertain: ${detail}`);
  if (response.status === 408 || response.status === 421 || response.status === 429 || response.status >= 500) {
    throw new MailRetryableError(`SMTP temporary failure (${response.status}): ${detail}`);
  }
  throw new MailPermanentError(`SMTP rejected message (${response.status}): ${detail}`);
}
