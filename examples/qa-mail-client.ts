/**
 * Test-harness client for the QA email worker.
 *
 * Drop this into your test project (it has no dependencies beyond `fetch`) and
 * use it to mint a throwaway inbox per test, then block until the mail arrives.
 *
 *   const mail = new QaMail({ baseUrl: process.env.QA_MAIL_URL!, token: process.env.QA_MAIL_TOKEN! });
 *   const inbox = mail.newInbox("checkout");           // qa-checkout-<uuid>@sodality.chat
 *   await placeOrder(inbox.address);
 *   const msg = await inbox.waitFor({ subject: "order confirmation", timeoutSeconds: 300 });
 *   const link = firstLink(msg.html ?? msg.text ?? "");
 *
 * The server pushes arrivals rather than polling, so a long wait is cheap: each
 * chained window costs about two KV list operations no matter how long it runs.
 */

export interface QaMailOptions {
  /** e.g. https://qa-email-worker.<subdomain>.workers.dev */
  baseUrl: string;
  token: string;
  domain?: string;
  fetchImpl?: typeof fetch;
}

export interface MessageSummary {
  id: string;
  /** Epoch MILLISECONDS. Java: use `receivedAt` instead, or toEpochMilli(). */
  ts: number;
  inbox: string;
  from: string | null;
  subject: string;
  size: number;
  attachments: number;
  skippedParse: boolean;
}

export interface Otp {
  code: string;
  origin: string;
}

export interface Message extends MessageSummary {
  /** ISO-8601, the same instant as `ts`. Unambiguous across languages. */
  receivedAt: string;
  envelopeFrom: string;
  envelopeTo: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  messageId: string | null;
  headers: Record<string, string>;
  text: string | null;
  html: string | null;
  /** From the sender's OTP-Token header, if any. Unauthenticated. */
  otp: Otp | null;
  truncated: boolean;
  parseError: string | null;
}

export interface WaitOptions {
  /** Total time to wait. Chained across server windows; no practical ceiling. */
  timeoutSeconds?: number;
  /** Only consider mail received after this instant. Epoch ms or seconds. */
  since?: number;
  from?: string;
  subject?: string;
  contains?: string;
  hasAttachment?: boolean;
}

export class QaMailTimeoutError extends Error {
  constructor(
    readonly inbox: string,
    readonly waitedMs: number,
    readonly filter: unknown,
  ) {
    super(`No matching mail for ${inbox} after ${waitedMs}ms (filter: ${JSON.stringify(filter)})`);
    this.name = "QaMailTimeoutError";
  }
}

export class QaMailHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`QA mail API ${status} for ${url}: ${body}`);
    this.name = "QaMailHttpError";
  }
}

export class Inbox {
  constructor(
    readonly address: string,
    private readonly client: QaMail,
  ) {}

  list(limit = 25, since = 0): Promise<MessageSummary[]> {
    return this.client.list(this.address, limit, since);
  }

  latest(): Promise<Message> {
    return this.client.latest(this.address);
  }

  waitFor(options: WaitOptions = {}): Promise<Message> {
    return this.client.waitFor(this.address, options);
  }

  purge(): Promise<number> {
    return this.client.purge(this.address);
  }

  waiters(): Promise<{ waiters: number; recent: number }> {
    return this.client.waiters(this.address);
  }
}

export class QaMail {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly domain: string;
  private readonly doFetch: typeof fetch;

  constructor(options: QaMailOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.domain = options.domain ?? "sodality.chat";
    this.doFetch = options.fetchImpl ?? fetch;
  }

  /** Mints a unique address; nothing needs to be registered server-side. */
  newInbox(label = "test"): Inbox {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return new Inbox(`qa-${slug}-${crypto.randomUUID().slice(0, 8)}@${this.domain}`, this);
  }

  inbox(address: string): Inbox {
    return new Inbox(address, this);
  }

  async list(address: string, limit = 25, since = 0): Promise<MessageSummary[]> {
    const url = this.url(`/v1/inboxes/${encodeURIComponent(address)}/messages`, { limit, since });
    return (await this.request<{ messages: MessageSummary[] }>(url)).messages;
  }

  latest(address: string): Promise<Message> {
    return this.request<Message>(
      this.url(`/v1/inboxes/${encodeURIComponent(address)}/messages/latest`),
    );
  }

  byId(id: string): Promise<Message> {
    return this.request<Message>(this.url(`/v1/messages/${encodeURIComponent(id)}`));
  }

  /** Diagnostic: how many requests are currently blocked on this inbox. */
  waiters(address: string): Promise<{ waiters: number; recent: number }> {
    return this.request(this.url(`/v1/inboxes/${encodeURIComponent(address)}/waiters`));
  }

  async purge(address: string): Promise<number> {
    const url = this.url(`/v1/inboxes/${encodeURIComponent(address)}/messages`);
    return (await this.request<{ deleted: number }>(url, { method: "DELETE" })).deleted;
  }

  /**
   * Blocks until a matching message arrives. The server caps one window at
   * MAX_WAIT_SECONDS (60 by default), so longer waits are chained here —
   * `timeoutSeconds: 300` for a Shopify login mail that takes minutes is fine.
   */
  async waitFor(address: string, options: WaitOptions = {}): Promise<Message> {
    const totalMs = (options.timeoutSeconds ?? 30) * 1000;
    const startedAt = Date.now();
    const deadline = startedAt + totalMs;
    const since = options.since ?? 0;

    for (;;) {
      const remainingSeconds = Math.ceil((deadline - Date.now()) / 1000);
      if (remainingSeconds <= 0) break;

      const url = this.url(`/v1/inboxes/${encodeURIComponent(address)}/wait`, {
        timeout: Math.min(remainingSeconds, 60),
        since,
        from: options.from,
        subject: options.subject,
        contains: options.contains,
        hasAttachment: options.hasAttachment,
      });

      const response = await this.doFetch(url, { headers: this.headers() });
      if (response.status === 200) return (await response.json()) as Message;

      if (response.status !== 408) {
        throw new QaMailHttpError(response.status, await response.text(), url);
      }
      // 408 only means this window elapsed. `since` deliberately stays put so a
      // message that landed mid-window is still matched on the next call.
    }

    throw new QaMailTimeoutError(address, Date.now() - startedAt, options);
  }

  private headers(): HeadersInit {
    return { authorization: `Bearer ${this.token}` };
  }

  private url(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.doFetch(url, {
      ...init,
      headers: { ...this.headers(), ...init.headers },
    });
    if (!response.ok) throw new QaMailHttpError(response.status, await response.text(), url);
    return (await response.json()) as T;
  }
}

/** Convenience: first http(s) link in an email body. */
export function firstLink(body: string): string | null {
  const href = body.match(/href\s*=\s*["']([^"']+)["']/i);
  if (href?.[1]) return href[1];
  const bare = body.match(/https?:\/\/[^\s"'<>)]+/i);
  return bare?.[0] ?? null;
}

/** Convenience: first N-digit code in an email body (default 6). */
export function firstCode(body: string, digits = 6): string | null {
  const match = body.match(new RegExp(`\\b\\d{${digits}}\\b`));
  return match?.[0] ?? null;
}
