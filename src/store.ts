import type { MessageSummary, StoredMessage } from "./types";
import type { Logger } from "./log";

/**
 * KV layout
 * ---------
 *   msg:<inbox>:<invTs>:<id>  -> JSON StoredMessage        (metadata: MessageSummary)
 *   id:<id>                   -> the msg key above         (lookup/delete by id)
 *
 * <invTs> is (MAX_TS - receiptTimeMs) zero-padded to 13 digits, so a prefix
 * list over an inbox comes back newest-first without any sorting on our side.
 */

const MSG_PREFIX = "msg:";
const ID_PREFIX = "id:";
const MAX_TS = 9_999_999_999_999; // 13 digits; overflows in the year 2286.
const KV_LIST_MAX = 1000;

/** Lowercases, trims and strips any `Display Name <addr>` wrapper. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  const angled = trimmed.match(/<([^>]*)>\s*$/);
  const bare = angled?.[1] ?? trimmed;
  return bare.trim().toLowerCase();
}

export function inboxPrefix(inbox: string): string {
  return `${MSG_PREFIX}${inbox}:`;
}

export function messageKey(inbox: string, ts: number, id: string): string {
  const inverted = String(MAX_TS - ts).padStart(13, "0");
  return `${inboxPrefix(inbox)}${inverted}:${id}`;
}

export function idKey(id: string): string {
  return `${ID_PREFIX}${id}`;
}

/** Pulls the message id back out of a `msg:` key. */
export function idFromMessageKey(key: string): string | null {
  const lastColon = key.lastIndexOf(":");
  if (lastColon < 0 || lastColon === key.length - 1) return null;
  return key.slice(lastColon + 1);
}

export function toSummary(message: StoredMessage): MessageSummary {
  return {
    id: message.id,
    ts: message.ts,
    inbox: message.inbox,
    from: message.from,
    // KV caps metadata at 1024 bytes — keep the subject short enough that a
    // long one can never push the record over the limit.
    subject: message.subject.slice(0, 300),
    size: message.rawSize,
    attachments: message.attachments.length,
    skippedParse: message.skippedParse,
  };
}

export async function putMessage(
  kv: KVNamespace,
  message: StoredMessage,
  ttlSeconds: number,
  log: Logger,
): Promise<string> {
  const key = messageKey(message.inbox, message.ts, message.id);
  const body = JSON.stringify(message);

  await kv.put(key, body, { expirationTtl: ttlSeconds, metadata: toSummary(message) });

  try {
    await kv.put(idKey(message.id), key, { expirationTtl: ttlSeconds });
  } catch (err) {
    // The message itself is stored and listable; only id lookup is degraded.
    // Log loudly rather than failing the whole delivery.
    log.exception(err, "failed to write id index for message", { messageId: message.id, key });
  }

  return key;
}

export interface ListOptions {
  limit: number;
  /** Only return messages received strictly after this epoch-ms value. */
  sinceTs?: number;
}

/**
 * Newest-first summaries for an inbox, read straight from KV list metadata
 * (no value reads).
 */
export async function listSummaries(
  kv: KVNamespace,
  inbox: string,
  options: ListOptions,
  log: Logger,
): Promise<MessageSummary[]> {
  const prefix = inboxPrefix(inbox);
  const limit = Math.min(Math.max(options.limit, 1), KV_LIST_MAX);
  const since = options.sinceTs ?? 0;

  const listed = await kv.list<MessageSummary>({ prefix, limit });
  const out: MessageSummary[] = [];

  for (const entry of listed.keys) {
    const meta = entry.metadata;
    if (!meta) {
      // Written by an older version, or metadata was dropped. Surface it —
      // the record is still readable by id.
      log.warn("kv entry has no metadata, skipping in listing", { key: entry.name });
      continue;
    }
    // Keys are ordered newest-first, so the first too-old entry ends the scan.
    if (meta.ts <= since) break;
    out.push(meta);
  }

  return out;
}

export async function getMessageByKey(
  kv: KVNamespace,
  key: string,
  log: Logger,
): Promise<StoredMessage | null> {
  const raw = await kv.get(key, "text");
  if (raw === null) return null;

  try {
    return JSON.parse(raw) as StoredMessage;
  } catch (err) {
    log.exception(err, "stored message is not valid JSON", { key });
    return null;
  }
}

export async function getMessageById(
  kv: KVNamespace,
  id: string,
  log: Logger,
): Promise<StoredMessage | null> {
  const key = await kv.get(idKey(id), "text");
  if (key === null) return null;
  return getMessageByKey(kv, key, log);
}

export async function deleteMessageById(
  kv: KVNamespace,
  id: string,
  log: Logger,
): Promise<boolean> {
  const key = await kv.get(idKey(id), "text");
  if (key === null) return false;

  await kv.delete(key);

  try {
    await kv.delete(idKey(id));
  } catch (err) {
    // Leaves a dangling index entry that expires on its own; not fatal.
    log.exception(err, "failed to delete id index entry", { messageId: id, key });
  }

  return true;
}

/** Deletes every message in an inbox. Returns how many keys were removed. */
export async function purgeInbox(kv: KVNamespace, inbox: string, log: Logger): Promise<number> {
  const prefix = inboxPrefix(inbox);
  let cursor: string | undefined;
  let deleted = 0;

  for (;;) {
    const page: KVNamespaceListResult<unknown> = await kv.list({ prefix, limit: KV_LIST_MAX, cursor });

    for (const entry of page.keys) {
      await kv.delete(entry.name);
      deleted += 1;

      const id = idFromMessageKey(entry.name);
      if (id === null) {
        log.warn("could not derive message id from key during purge", { key: entry.name });
        continue;
      }

      try {
        await kv.delete(idKey(id));
      } catch (err) {
        log.exception(err, "failed to delete id index entry during purge", {
          messageId: id,
          key: entry.name,
        });
      }
    }

    if (page.list_complete) break;
    cursor = page.cursor;
    if (!cursor) break;
  }

  return deleted;
}

/**
 * Every message across every inbox, newest-first. Debug/diagnostic use: this is
 * how you find mail that arrived under an address you did not expect (envelope
 * recipient differing from the header To:, plus-addressing, a typo'd alias).
 *
 * Scans up to `scanCap` keys, so it is a diagnostic, not a hot path.
 */
export async function listAllSummaries(
  kv: KVNamespace,
  limit: number,
  log: Logger,
  scanCap = 2000,
): Promise<MessageSummary[]> {
  const collected: MessageSummary[] = [];
  let cursor: string | undefined;
  let scanned = 0;

  for (;;) {
    const page = await kv.list<MessageSummary>({ prefix: MSG_PREFIX, limit: KV_LIST_MAX, cursor });

    for (const entry of page.keys) {
      scanned += 1;
      if (entry.metadata) collected.push(entry.metadata);
      else log.warn("kv entry has no metadata during full scan", { key: entry.name });
    }

    if (page.list_complete || scanned >= scanCap) break;
    cursor = page.cursor;
    if (!cursor) break;
  }

  // Keys sort newest-first only within one inbox, so sort across inboxes here.
  collected.sort((a, b) => b.ts - a.ts);
  return collected.slice(0, limit);
}

export interface InboxStat {
  inbox: string;
  count: number;
  newestTs: number;
  newestSubject: string;
}

/** Distinct inboxes that currently hold messages, most-recent-first. */
export async function listInboxes(kv: KVNamespace, log: Logger): Promise<InboxStat[]> {
  const all = await listAllSummaries(kv, Number.MAX_SAFE_INTEGER, log);
  const byInbox = new Map<string, InboxStat>();

  for (const summary of all) {
    const existing = byInbox.get(summary.inbox);
    if (!existing) {
      byInbox.set(summary.inbox, {
        inbox: summary.inbox,
        count: 1,
        newestTs: summary.ts,
        newestSubject: summary.subject,
      });
      continue;
    }
    existing.count += 1;
    if (summary.ts > existing.newestTs) {
      existing.newestTs = summary.ts;
      existing.newestSubject = summary.subject;
    }
  }

  return [...byInbox.values()].sort((a, b) => b.newestTs - a.newestTs);
}
