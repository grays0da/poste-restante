import { DurableObject } from "cloudflare:workers";

import { summaryMatches, type SummaryFilter } from "./filter";
import { createLogger } from "./log";
import type { Env, MessageSummary } from "./types";

/**
 * One Durable Object per inbox, used as a notification bus and nothing else.
 *
 * KV stays the source of truth: this object holds no messages, only the
 * in-memory list of requests currently blocked on `waitFor`, plus a short ring
 * buffer of recent arrivals to close the registration race.
 *
 * Why this exists: polling KV every 500ms for a 5-minute wait costs ~600 list
 * operations. With this, a wait costs one list up front and one at the end —
 * the arrival itself is pushed.
 *
 * Deliberately NOT durable: if the object is evicted or restarted mid-wait, the
 * blocked requests are lost. The API layer's closing list call is the safety
 * net for that, so a lost notification costs latency, never a missed message.
 */

interface Waiter {
  sinceTs: number;
  filter: SummaryFilter;
  resolve: (value: MessageSummary | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Arrivals kept for late registrations. Small: this is a race window, not a cache. */
const RECENT_LIMIT = 50;

export class InboxNotifier extends DurableObject<Env> {
  private readonly waiters = new Set<Waiter>();
  private recent: MessageSummary[] = [];

  /**
   * Called by the email handler once a message is committed to KV. Returns how
   * many blocked requests were woken, which is what the ingest log reports.
   */
  async notify(summary: MessageSummary): Promise<number> {
    this.recent.push(summary);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();

    let delivered = 0;

    for (const waiter of [...this.waiters]) {
      if (summary.ts <= waiter.sinceTs) continue;
      if (!summaryMatches(summary, waiter.filter)) continue;

      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(summary);
      delivered += 1;
    }

    return delivered;
  }

  /**
   * Blocks until a matching message arrives or `timeoutMs` elapses. Resolves
   * with the arrival's summary, or null on timeout.
   */
  async waitFor(
    sinceTs: number,
    filter: SummaryFilter,
    timeoutMs: number,
  ): Promise<MessageSummary | null> {
    // A message can be stored and notified between the caller's own KV check
    // and this call arriving. The ring buffer closes that window.
    const buffered = this.recent
      .filter((summary) => summary.ts > sinceTs && summaryMatches(summary, filter))
      .sort((a, b) => a.ts - b.ts)[0];
    if (buffered) return buffered;

    return new Promise<MessageSummary | null>((resolve) => {
      const waiter: Waiter = {
        sinceTs,
        filter,
        resolve,
        // Replaced immediately below; the field exists so the timer can remove
        // its own waiter.
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
      };

      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);

      this.waiters.add(waiter);
    });
  }

  /** Diagnostic: how many requests are blocked here right now. */
  async stats(): Promise<{ waiters: number; recent: number; newestTs: number | null }> {
    const newest = this.recent[this.recent.length - 1];
    return {
      waiters: this.waiters.size,
      recent: this.recent.length,
      newestTs: newest?.ts ?? null,
    };
  }

  /** Drops every blocked request and the ring buffer. Used by the purge route. */
  async reset(): Promise<number> {
    const log = createLogger(this.env.LOG_LEVEL, { component: "inbox-do" });
    const dropped = this.waiters.size;

    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(null);
    }
    this.recent = [];

    if (dropped > 0) log.info("reset dropped blocked waiters", { dropped });
    return dropped;
  }
}
