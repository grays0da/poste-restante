import { loadConfig, type Config } from "./config";
import { bodyMatches, summaryMatches, summaryOnly, type Filter } from "./filter";
import { createLogger, type Logger } from "./log";
import {
  deleteMessageById,
  getMessageById,
  getMessageByKey,
  listAllSummaries,
  listInboxes,
  listSummaries,
  messageKey,
  normalizeAddress,
  purgeInbox,
} from "./store";
import type { Env, StoredMessage } from "./types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function errorResponse(status: number, error: string, detail?: unknown): Response {
  return json(detail === undefined ? { error } : { error, detail }, status);
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** Constant-time-ish comparison: digest both sides, then compare fixed-width. */
async function tokensMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function authorize(request: Request, env: Env, log: Logger): Promise<Response | null> {
  const expected = env.API_TOKEN;
  if (!expected) {
    log.error("API_TOKEN is not configured; refusing all API requests");
    return errorResponse(503, "api_token_not_configured");
  }

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return errorResponse(401, "missing_bearer_token");

  try {
    if (!(await tokensMatch(match[1], expected))) {
      log.warn("rejected request with invalid token", { path: new URL(request.url).pathname });
      return errorResponse(403, "invalid_token");
    }
  } catch (err) {
    log.exception(err, "token comparison failed");
    return errorResponse(500, "token_comparison_failed");
  }

  return null;
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * `since` accepts epoch milliseconds or epoch seconds. Anything below 1e11 is
 * read as seconds (1e11 ms is 1973; 1e11 s is the year 5138), so every
 * realistic seconds value scales up and every ms value passes through.
 *
 * Without this, a seconds value silently means "since 1970" and the filter
 * matches everything instead of erroring.
 */
function sinceParam(url: URL): number {
  const raw = intParam(url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
  if (raw === 0) return 0;
  return raw < 100_000_000_000 ? raw * 1000 : raw;
}

function readFilter(url: URL): Filter {
  const lower = (name: string) => url.searchParams.get(name)?.toLowerCase() ?? null;
  const attachmentRaw = url.searchParams.get("hasAttachment");
  return {
    from: lower("from"),
    subject: lower("subject"),
    contains: lower("contains"),
    hasAttachment: attachmentRaw === null ? null : attachmentRaw === "true" || attachmentRaw === "1",
  };
}

/** Oldest matching message in KV newer than `sinceTs`, or null. One list call. */
async function firstMatchFromList(
  env: Env,
  inbox: string,
  filter: Filter,
  sinceTs: number,
  log: Logger,
): Promise<StoredMessage | null> {
  const summaries = await listSummaries(env.QA_MAIL, inbox, { limit: 100, sinceTs }, log);

  // listSummaries is newest-first; walk oldest-first so repeated calls with the
  // same `since` return messages in arrival order.
  for (let i = summaries.length - 1; i >= 0; i -= 1) {
    const summary = summaries[i];
    if (!summary || !summaryMatches(summary, filter)) continue;

    const message = await getMessageByKey(env.QA_MAIL, messageKey(inbox, summary.ts, summary.id), log);
    if (!message) {
      log.warn("listed key had no readable value, skipping", { id: summary.id, ts: summary.ts });
      continue;
    }
    if (bodyMatches(message, filter)) return message;
  }

  return null;
}

/** Resolves when the client goes away. Never rejects. */
function abortPromise(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

/**
 * Waits for a matching message, driven by push rather than polling.
 *
 *   1. one KV list up front  - the message may already be there
 *   2. block on the inbox's Durable Object until it is notified of an arrival
 *   3. one KV list at the end - safety net, in case a notification was lost
 *
 * Cost is therefore ~2 list operations per wait window regardless of how long
 * the wait runs, instead of one list per poll interval.
 */
async function waitForMessage(
  env: Env,
  _config: Config,
  inbox: string,
  filter: Filter,
  sinceTs: number,
  deadline: number,
  signal: AbortSignal,
  log: Logger,
): Promise<StoredMessage | null> {
  let lists = 1;
  let notifications = 0;

  const alreadyThere = await firstMatchFromList(env, inbox, filter, sinceTs, log);
  if (alreadyThere) {
    log.info("wait satisfied from the initial list", { lists });
    return alreadyThere;
  }

  const stub = env.INBOX_NOTIFIER.get(env.INBOX_NOTIFIER.idFromName(inbox));
  const pushFilter = summaryOnly(filter);
  let cursorTs = sinceTs;

  while (Date.now() < deadline) {
    if (signal.aborted) {
      log.info("wait aborted by client", { lists, notifications });
      return null;
    }

    const outcome = await Promise.race([
      stub.waitFor(cursorTs, pushFilter, deadline - Date.now()),
      abortPromise(signal),
    ]);

    if (outcome === "aborted") {
      log.info("wait aborted by client", { lists, notifications });
      return null;
    }
    if (outcome === null) break; // the DO's own timer fired

    notifications += 1;
    const summary = outcome;
    const message = await getMessageByKey(
      env.QA_MAIL,
      messageKey(inbox, summary.ts, summary.id),
      log,
    );

    if (message && bodyMatches(message, filter)) {
      log.info("wait satisfied by notification", { lists, notifications, matchedId: summary.id });
      return message;
    }

    // Either the value was not readable yet, or the body filter rejected it.
    // Advance past it so the DO does not hand us the same message again.
    cursorTs = Math.max(cursorTs, summary.ts);
  }

  // A notification can be lost: the DO holds waiters in memory only, so an
  // eviction or a failed notify call would leave us waiting for nothing.
  lists += 1;
  const late = await firstMatchFromList(env, inbox, filter, sinceTs, log);
  log.info("wait finished", { lists, notifications, matched: late !== null });
  return late;
}

export async function handleRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const rootLog = createLogger(env.LOG_LEVEL, { component: "api", requestId });
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const log = rootLog.child({ method: request.method, path: url.pathname });

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "qa-email-worker", domain: env.MAIL_DOMAIN ?? null });
    }

    const denied = await authorize(request, env, log);
    if (denied) return denied;

    const config = loadConfig(env, log);

    if (segments[0] !== "v1") return errorResponse(404, "not_found");

    // GET /v1/inboxes  — every inbox currently holding mail (diagnostic)
    if (segments[1] === "inboxes" && segments.length === 2) {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed");
      const inboxes = await listInboxes(env.QA_MAIL, log);
      return json({ count: inboxes.length, inboxes });
    }

    // GET /v1/messages  — everything, across all inboxes (diagnostic)
    if (segments[1] === "messages" && segments.length === 2) {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed");
      const summaries = await listAllSummaries(env.QA_MAIL, intParam(url, "limit", 50, 1, 1000), log);
      return json({ count: summaries.length, messages: summaries });
    }

    // /v1/messages/:id
    if (segments[1] === "messages" && segments.length === 3) {
      const id = decodeURIComponent(segments[2] as string);

      if (request.method === "GET") {
        const message = await getMessageById(env.QA_MAIL, id, log);
        return message ? json(message) : errorResponse(404, "message_not_found");
      }
      if (request.method === "DELETE") {
        const removed = await deleteMessageById(env.QA_MAIL, id, log);
        return removed ? json({ deleted: true, id }) : errorResponse(404, "message_not_found");
      }
      return errorResponse(405, "method_not_allowed");
    }

    // /v1/inboxes/:address/...
    if (segments[1] === "inboxes" && segments.length >= 3) {
      const inbox = normalizeAddress(decodeURIComponent(segments[2] as string));
      if (!inbox.includes("@")) return errorResponse(400, "invalid_inbox_address", inbox);

      const tail = segments.slice(3);
      const inboxLog = log.child({ inbox });

      // GET/DELETE /v1/inboxes/:address/messages
      if (tail[0] === "messages" && tail.length === 1) {
        if (request.method === "GET") {
          const summaries = await listSummaries(
            env.QA_MAIL,
            inbox,
            { limit: intParam(url, "limit", 25, 1, 1000), sinceTs: sinceParam(url) },
            inboxLog,
          );
          return json({ inbox, count: summaries.length, messages: summaries });
        }
        if (request.method === "DELETE") {
          const deleted = await purgeInbox(env.QA_MAIL, inbox, inboxLog);

          try {
            const stub = env.INBOX_NOTIFIER.get(env.INBOX_NOTIFIER.idFromName(inbox));
            await stub.reset();
          } catch (err) {
            // Purge already succeeded; stale ring-buffer entries only mean a
            // waiter may be woken for a message that no longer exists, and the
            // KV read for it returns null.
            inboxLog.exception(err, "failed to reset inbox notifier after purge", { inbox });
          }

          inboxLog.info("purged inbox", { deleted });
          return json({ inbox, deleted });
        }
        return errorResponse(405, "method_not_allowed");
      }

      // GET /v1/inboxes/:address/messages/latest
      if (tail[0] === "messages" && tail[1] === "latest" && tail.length === 2) {
        if (request.method !== "GET") return errorResponse(405, "method_not_allowed");
        const summaries = await listSummaries(env.QA_MAIL, inbox, { limit: 1 }, inboxLog);
        const newest = summaries[0];
        if (!newest) return errorResponse(404, "inbox_empty");
        const message = await getMessageByKey(
          env.QA_MAIL,
          messageKey(inbox, newest.ts, newest.id),
          inboxLog,
        );
        return message ? json(message) : errorResponse(404, "message_not_found");
      }

      // GET /v1/inboxes/:address/waiters — diagnostic: is push actually wired up
      if (tail[0] === "waiters" && tail.length === 1) {
        if (request.method !== "GET") return errorResponse(405, "method_not_allowed");
        const stub = env.INBOX_NOTIFIER.get(env.INBOX_NOTIFIER.idFromName(inbox));
        return json({ inbox, ...(await stub.stats()) });
      }

      // GET /v1/inboxes/:address/wait
      if (tail[0] === "wait" && tail.length === 1) {
        if (request.method !== "GET") return errorResponse(405, "method_not_allowed");

        const timeoutSeconds = intParam(url, "timeout", 30, 1, config.maxWaitSeconds);
        const sinceTs = sinceParam(url);
        const filter = readFilter(url);
        const startedAt = Date.now();
        const deadline = startedAt + timeoutSeconds * 1000;

        const message = await waitForMessage(
          env,
          config,
          inbox,
          filter,
          sinceTs,
          deadline,
          request.signal,
          inboxLog.child({ timeoutSeconds, sinceTs }),
        );

        if (!message) {
          return json({ error: "timeout", inbox, waitedMs: Date.now() - startedAt, filter }, 408);
        }
        return json(message, 200, { "x-waited-ms": String(Date.now() - startedAt) });
      }

      return errorResponse(404, "not_found");
    }

    return errorResponse(404, "not_found");
  } catch (err) {
    // Catch-all: log with the request id so the 500 body can be traced back to
    // a specific log line in `wrangler tail`.
    rootLog.exception(err, "unhandled error in API request", {
      method: request.method,
      path: url.pathname,
    });
    return errorResponse(500, "internal_error", { requestId });
  }
}
