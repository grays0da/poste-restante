import type { Env } from "./types";
import type { Logger } from "./log";

export interface Config {
  mailDomain: string;
  retentionSeconds: number;
  maxEmailBytes: number;
  maxBodyChars: number;
  storeAttachmentMaxBytes: number;
  maxWaitSeconds: number;
  maxMimeParts: number;
  allowedRecipient: RegExp | null;
}

/** KV rejects an expirationTtl below 60 seconds. */
const KV_MIN_TTL_SECONDS = 60;

function num(
  log: Logger,
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    log.warn("config value is not a number, using fallback", { setting: name, raw, fallback });
    return fallback;
  }

  const clamped = Math.min(Math.max(Math.trunc(parsed), min), max);
  if (clamped !== Math.trunc(parsed)) {
    log.warn("config value out of range, clamped", { setting: name, raw, clamped, min, max });
  }
  return clamped;
}

export function loadConfig(env: Env, log: Logger): Config {
  let allowedRecipient: RegExp | null = null;
  const pattern = env.ALLOWED_RECIPIENT_PATTERN;
  if (pattern) {
    try {
      allowedRecipient = new RegExp(pattern, "i");
    } catch (err) {
      // A broken pattern must not silently become "allow everything" without a
      // trace in the logs.
      log.exception(err, "ALLOWED_RECIPIENT_PATTERN is not a valid regex; accepting all recipients", {
        pattern,
      });
      allowedRecipient = null;
    }
  }

  return {
    mailDomain: env.MAIL_DOMAIN ?? "",
    retentionSeconds: num(log, "RETENTION_SECONDS", env.RETENTION_SECONDS, 86_400, KV_MIN_TTL_SECONDS, 31_536_000),
    maxEmailBytes: num(log, "MAX_EMAIL_BYTES", env.MAX_EMAIL_BYTES, 5_242_880, 1_024, 24_000_000),
    maxBodyChars: num(log, "MAX_BODY_CHARS", env.MAX_BODY_CHARS, 262_144, 256, 5_000_000),
    storeAttachmentMaxBytes: num(log, "STORE_ATTACHMENT_MAX_BYTES", env.STORE_ATTACHMENT_MAX_BYTES, 0, 0, 5_000_000),
    maxWaitSeconds: num(log, "MAX_WAIT_SECONDS", env.MAX_WAIT_SECONDS, 60, 1, 90),
    maxMimeParts: num(log, "MAX_MIME_PARTS", env.MAX_MIME_PARTS, 200, 1, 10_000),
    allowedRecipient,
  };
}
