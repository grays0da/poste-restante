/**
 * Shared types for the QA email worker.
 *
 * Terminology:
 *   inbox   - a normalised recipient address, e.g. "qa-abc123@sodality.chat"
 *   message - one received email, stored as a single KV entry
 *   summary - the KV metadata attached to that entry (cheap to list)
 */

import type { InboxNotifier } from "./inbox-do";

export interface Env {
  /** KV namespace holding messages and the id -> key index. */
  QA_MAIL: KVNamespace;

  /** One Durable Object per inbox, used purely to push arrival notifications. */
  INBOX_NOTIFIER: DurableObjectNamespace<InboxNotifier>;

  /** Bearer token for the HTTP API. Set with `wrangler secret put API_TOKEN`. */
  API_TOKEN: string;

  MAIL_DOMAIN?: string;
  RETENTION_SECONDS?: string;
  MAX_EMAIL_BYTES?: string;
  MAX_BODY_CHARS?: string;
  STORE_ATTACHMENT_MAX_BYTES?: string;
  MAX_WAIT_SECONDS?: string;
  MAX_MIME_PARTS?: string;
  ALLOWED_RECIPIENT_PATTERN?: string;
  LOG_LEVEL?: string;
}

export interface StoredAttachment {
  filename: string | null;
  mimeType: string | null;
  disposition: string | null;
  size: number;
  /** base64 content, only when under STORE_ATTACHMENT_MAX_BYTES. */
  contentBase64?: string;
}

/**
 * One-time passcode from the sender's `OTP-Token` header, when present.
 * NOT authenticated — the sender sets this header and the parser does not
 * verify it. Fine for test assertions, never a security control.
 */
export interface StoredOtp {
  code: string;
  origin: string;
}

/** The full record written as the KV value. */
export interface StoredMessage {
  id: string;
  /** Receipt time, epoch MILLISECONDS. Assigned by the worker, not the sender. */
  ts: number;
  /** Same instant as `ts`, ISO-8601 — prefer this when comparing in Java. */
  receivedAt: string;
  /** Normalised envelope recipient — the inbox this message belongs to. */
  inbox: string;
  /** Raw envelope values as delivered by Cloudflare. */
  envelopeTo: string;
  envelopeFrom: string;
  /** Header-derived fields (may differ from the envelope). */
  from: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  replyTo: string[];
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  date: string | null;
  headers: Record<string, string>;
  text: string | null;
  html: string | null;
  otp: StoredOtp | null;
  attachments: StoredAttachment[];
  rawSize: number;
  /** True when text/html were cut at MAX_BODY_CHARS. */
  truncated: boolean;
  /** True when the mail exceeded MAX_EMAIL_BYTES or failed to parse. */
  skippedParse: boolean;
  /** Set when MIME parsing threw; the record is a metadata-only stub. */
  parseError: string | null;
}

/** KV metadata — must stay under 1024 bytes serialised. */
export interface MessageSummary {
  id: string;
  ts: number;
  inbox: string;
  from: string | null;
  subject: string;
  size: number;
  attachments: number;
  skippedParse: boolean;
}
