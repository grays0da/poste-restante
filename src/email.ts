import PostalMime from "postal-mime";
import type { Address, Email } from "postal-mime";

import { loadConfig } from "./config";
import { createLogger, serializeError } from "./log";
import { normalizeAddress, putMessage, toSummary } from "./store";
import type { Env, StoredAttachment, StoredMessage } from "./types";

/** Flattens postal-mime address entries (which may be groups) to strings. */
function addressList(entries: Address[] | undefined): string[] {
  if (!entries) return [];
  const out: string[] = [];

  for (const entry of entries) {
    if (Array.isArray(entry.group)) {
      out.push(...addressList(entry.group));
      continue;
    }
    if (entry.address) out.push(entry.address.toLowerCase());
  }

  return out;
}

function truncate(
  value: string | undefined | null,
  maxChars: number,
): { value: string | null; truncated: boolean } {
  if (value === undefined || value === null) return { value: null, truncated: false };
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, maxChars), truncated: true };
}

function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function byteLength(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content === "string") return content.length;
  if (content instanceof Uint8Array) return content.byteLength;
  return content.byteLength;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers) out[key.toLowerCase()] = value;
  return out;
}

/**
 * Builds a record for mail we could not (or would not) parse, so a test still
 * sees that something arrived instead of timing out with no explanation.
 */
function stubMessage(
  base: Pick<
    StoredMessage,
    "id" | "ts" | "receivedAt" | "inbox" | "envelopeTo" | "envelopeFrom" | "rawSize"
  >,
  headers: Record<string, string>,
  parseError: string | null,
): StoredMessage {
  return {
    ...base,
    from: base.envelopeFrom || null,
    fromName: null,
    to: [base.envelopeTo],
    cc: [],
    replyTo: [],
    subject: headers["subject"] ?? "",
    messageId: headers["message-id"] ?? null,
    inReplyTo: headers["in-reply-to"] ?? null,
    references: headers["references"] ?? null,
    date: headers["date"] ?? null,
    headers,
    text: null,
    html: null,
    otp: null,
    attachments: [],
    truncated: false,
    skippedParse: true,
    parseError,
  };
}

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const rootLog = createLogger(env.LOG_LEVEL, { component: "email" });
  const config = loadConfig(env, rootLog);

  const ts = Date.now();
  const id = crypto.randomUUID();
  const inbox = normalizeAddress(message.to);
  const log = rootLog.child({ messageId: id, inbox });

  if (config.allowedRecipient && !config.allowedRecipient.test(inbox)) {
    log.warn("recipient rejected by ALLOWED_RECIPIENT_PATTERN", {
      pattern: config.allowedRecipient.source,
    });
    message.setReject("Recipient not accepted by this QA inbox");
    return;
  }

  const headers = headersToObject(message.headers);
  const base = {
    id,
    ts,
    receivedAt: new Date(ts).toISOString(),
    inbox,
    envelopeTo: message.to,
    envelopeFrom: message.from,
    rawSize: message.rawSize,
  };

  let record: StoredMessage;

  if (message.rawSize > config.maxEmailBytes) {
    log.warn("message exceeds MAX_EMAIL_BYTES, storing metadata-only stub", {
      rawSize: message.rawSize,
      maxEmailBytes: config.maxEmailBytes,
    });
    record = stubMessage(
      base,
      headers,
      `rawSize ${message.rawSize} exceeds MAX_EMAIL_BYTES ${config.maxEmailBytes}`,
    );
  } else {
    try {
      // Inbound mail on a catch-all domain is attacker-controlled, so cap the
      // parser's work explicitly rather than relying on its defaults.
      const parsed: Email = await PostalMime.parse(message.raw, {
        maxPartCount: config.maxMimeParts,
        maxHeadersSize: 262_144,
        maxNestingDepth: 32,
        maxRfc822NestingDepth: 3,
      });

      const text = truncate(parsed.text, config.maxBodyChars);
      const html = truncate(parsed.html, config.maxBodyChars);

      const attachments: StoredAttachment[] = (parsed.attachments ?? []).map((att) => {
        const size = byteLength(att.content);
        const stored: StoredAttachment = {
          filename: att.filename ?? null,
          mimeType: att.mimeType ?? null,
          disposition: att.disposition ?? null,
          size,
        };

        if (
          config.storeAttachmentMaxBytes > 0 &&
          size > 0 &&
          size <= config.storeAttachmentMaxBytes
        ) {
          try {
            stored.contentBase64 =
              typeof att.content === "string" ? att.content : toBase64(att.content);
          } catch (err) {
            // Keep the attachment metadata; only the bytes are lost.
            log.exception(err, "failed to base64-encode attachment", {
              filename: stored.filename,
              size,
            });
          }
        }

        return stored;
      });

      const from = Array.isArray(parsed.from?.group) ? undefined : parsed.from;

      record = {
        ...base,
        from: from?.address?.toLowerCase() ?? message.from ?? null,
        fromName: from?.name ?? null,
        to: addressList(parsed.to),
        cc: addressList(parsed.cc),
        replyTo: addressList(parsed.replyTo),
        subject: parsed.subject ?? headers["subject"] ?? "",
        messageId: parsed.messageId ?? headers["message-id"] ?? null,
        inReplyTo: parsed.inReplyTo ?? headers["in-reply-to"] ?? null,
        references: parsed.references ?? headers["references"] ?? null,
        date: parsed.date ?? headers["date"] ?? null,
        headers,
        text: text.value,
        html: html.value,
        // Sender-supplied and unauthenticated; fine for assertions, never a
        // security control.
        otp: parsed.otp ? { code: parsed.otp.code, origin: parsed.otp.origin } : null,
        attachments,
        truncated: text.truncated || html.truncated,
        skippedParse: false,
        parseError: null,
      };
    } catch (err) {
      // Do not drop the delivery: store what the envelope and headers gave us
      // and record why parsing failed.
      log.exception(err, "MIME parsing failed, storing metadata-only stub", {
        rawSize: message.rawSize,
        envelopeFrom: message.from,
      });
      record = stubMessage(base, headers, JSON.stringify(serializeError(err)));
    }
  }

  try {
    const key = await putMessage(env.QA_MAIL, record, config.retentionSeconds, log);
    log.info("stored message", {
      key,
      from: record.from,
      subject: record.subject.slice(0, 200),
      rawSize: record.rawSize,
      attachments: record.attachments.length,
      skippedParse: record.skippedParse,
      retentionSeconds: config.retentionSeconds,
    });
  } catch (err) {
    // Storage failure means the delivery really did fail. Log it and rethrow so
    // it shows up in Workers metrics and `wrangler tail` rather than vanishing.
    log.exception(err, "failed to store received message", {
      envelopeFrom: message.from,
      envelopeTo: message.to,
      rawSize: message.rawSize,
    });
    throw err;
  }

  // Wake anything blocked on /wait for this inbox. Non-fatal by design: the
  // message is already in KV, and a waiter's closing list call will find it.
  try {
    const stub = env.INBOX_NOTIFIER.get(env.INBOX_NOTIFIER.idFromName(record.inbox));
    const woken = await stub.notify(toSummary(record));
    log.debug("notified inbox waiters", { woken });
  } catch (err) {
    log.exception(err, "failed to notify inbox waiters; they will fall back to a list call", {
      inbox: record.inbox,
      messageId: record.id,
    });
  }
}
