import type { MessageSummary, StoredMessage } from "./types";

/**
 * Filters a caller may apply to `wait`.
 *
 * `from`, `subject` and `hasAttachment` are decidable from KV list metadata
 * alone, so they are evaluated inside the Durable Object. `contains` needs the
 * body, so only the API layer can decide it.
 */
export interface SummaryFilter {
  from: string | null;
  subject: string | null;
  hasAttachment: boolean | null;
}

export interface Filter extends SummaryFilter {
  contains: string | null;
}

/** Drops the body-dependent part so the filter can cross to the DO. */
export function summaryOnly(filter: Filter): SummaryFilter {
  return { from: filter.from, subject: filter.subject, hasAttachment: filter.hasAttachment };
}

export function summaryMatches(summary: MessageSummary, filter: SummaryFilter): boolean {
  if (filter.from && !(summary.from ?? "").toLowerCase().includes(filter.from)) return false;
  if (filter.subject && !summary.subject.toLowerCase().includes(filter.subject)) return false;
  if (filter.hasAttachment !== null && filter.hasAttachment !== (summary.attachments > 0)) return false;
  return true;
}

export function bodyMatches(message: StoredMessage, filter: Filter): boolean {
  if (!filter.contains) return true;
  const haystack = [message.subject, message.text ?? "", message.html ?? ""].join("\n").toLowerCase();
  return haystack.includes(filter.contains);
}
