import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { Env, MessageSummary, StoredMessage } from "../src/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

interface FakeMailOptions {
  to: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  extraHeaders?: string[];
}

/** Builds a minimal ForwardableEmailMessage backed by a real MIME string. */
function fakeMail(options: FakeMailOptions) {
  const from = options.from ?? "noreply@shop.example";
  const subject = options.subject ?? "Verify your account";
  const text = options.text ?? "Your code is 481516.";
  const html = options.html ?? `<p>${text}</p>`;
  const boundary = "b0undary";

  const raw = [
    `From: Shop Bot <${from}>`,
    `To: <${options.to}>`,
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@shop.example>`,
    `Date: ${new Date().toUTCString()}`,
    ...(options.extraHeaders ?? []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const bytes = new TextEncoder().encode(raw);
  const setReject = vi.fn();

  const message = {
    from,
    to: options.to,
    headers: new Headers({ from: `Shop Bot <${from}>`, to: options.to, subject }),
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.byteLength,
    canBeForwarded: true,
    setReject,
    forward: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };

  return { message: message as unknown as ForwardableEmailMessage, setReject };
}

async function deliver(options: FakeMailOptions, envOverrides: Partial<Env> = {}) {
  const { message, setReject } = fakeMail(options);
  const ctx = createExecutionContext();
  await worker.email(message, { ...env, ...envOverrides } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return { setReject };
}

function inboxUrl(address: string, suffix: string): string {
  return `https://qa/v1/inboxes/${encodeURIComponent(address)}${suffix}`;
}

async function listOf(inbox: string): Promise<MessageSummary[]> {
  const res = await SELF.fetch(inboxUrl(inbox, "/messages"), { headers: auth });
  return ((await res.json()) as { messages: MessageSummary[] }).messages;
}

describe("health", () => {
  it("is reachable without a token", async () => {
    const res = await SELF.fetch("https://qa/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, domain: "sodality.chat" });
  });
});

describe("auth", () => {
  it("rejects a missing token", async () => {
    const res = await SELF.fetch(inboxUrl("a@sodality.chat", "/messages"));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await SELF.fetch(inboxUrl("a@sodality.chat", "/messages"), {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(403);
  });
});

describe("ingest and listing", () => {
  it("stores an inbound message and lists it", async () => {
    const inbox = "qa-list@sodality.chat";
    await deliver({ to: inbox, subject: "Order 1001 confirmed" });

    const messages = await listOf(inbox);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toBe("Order 1001 confirmed");
    expect(messages[0]?.from).toBe("noreply@shop.example");
  });

  it("normalises the recipient so casing does not create two inboxes", async () => {
    await deliver({ to: "qa-Case@Sodality.Chat" });
    expect(await listOf("qa-case@sodality.chat")).toHaveLength(1);
  });

  it("returns the newest message first", async () => {
    const inbox = "qa-order@sodality.chat";
    await deliver({ to: inbox, subject: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await deliver({ to: inbox, subject: "second" });

    expect((await listOf(inbox)).map((m) => m.subject)).toEqual(["second", "first"]);
  });

  it("fetches, then deletes, a message by id", async () => {
    const inbox = "qa-byid@sodality.chat";
    await deliver({ to: inbox, text: "Your code is 999111." });
    const id = (await listOf(inbox))[0]!.id;

    const got = await SELF.fetch(`https://qa/v1/messages/${id}`, { headers: auth });
    expect(got.status).toBe(200);
    const message = (await got.json()) as StoredMessage;
    expect(message.text).toContain("999111");
    expect(message.html).toContain("999111");
    expect(message.skippedParse).toBe(false);
    expect(message.receivedAt).toBe(new Date(message.ts).toISOString());

    const del = await SELF.fetch(`https://qa/v1/messages/${id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);
    const gone = await SELF.fetch(`https://qa/v1/messages/${id}`, { headers: auth });
    expect(gone.status).toBe(404);
  });

  it("captures an OTP-Token header when the sender sets one", async () => {
    const inbox = "qa-otp@sodality.chat";
    await deliver({
      to: inbox,
      // RFC 9651 structured field: a String passcode with an `origin` parameter.
      extraHeaders: ['OTP-Token: "123456"; origin="https://shop.example"'],
    });

    const res = await SELF.fetch(inboxUrl(inbox, "/messages/latest"), { headers: auth });
    const message = (await res.json()) as StoredMessage;
    expect(message.otp).toEqual({ code: "123456", origin: "https://shop.example" });
  });

  it("purges an inbox", async () => {
    const inbox = "qa-purge@sodality.chat";
    await deliver({ to: inbox, subject: "one" });
    await deliver({ to: inbox, subject: "two" });

    const purge = await SELF.fetch(inboxUrl(inbox, "/messages"), { method: "DELETE", headers: auth });
    expect(await purge.json()).toMatchObject({ deleted: 2 });
    expect(await listOf(inbox)).toHaveLength(0);
  });
});

describe("guard rails", () => {
  it("stores a stub instead of parsing oversized mail", async () => {
    const inbox = "qa-big@sodality.chat";
    await deliver({ to: inbox, subject: "huge", text: "y".repeat(4000) }, { MAX_EMAIL_BYTES: "1024" });

    const res = await SELF.fetch(inboxUrl(inbox, "/messages/latest"), { headers: auth });
    const message = (await res.json()) as StoredMessage;
    expect(message.skippedParse).toBe(true);
    expect(message.parseError).toContain("MAX_EMAIL_BYTES");
    expect(message.text).toBeNull();
  });

  it("rejects a recipient outside ALLOWED_RECIPIENT_PATTERN", async () => {
    const inbox = "marketing@sodality.chat";
    const { setReject } = await deliver({ to: inbox }, { ALLOWED_RECIPIENT_PATTERN: "^qa-" });
    expect(setReject).toHaveBeenCalledOnce();
    expect(await listOf(inbox)).toHaveLength(0);
  });

  it("truncates bodies at MAX_BODY_CHARS", async () => {
    const inbox = "qa-trunc@sodality.chat";
    await deliver({ to: inbox, text: "x".repeat(5000) }, { MAX_BODY_CHARS: "256" });

    const res = await SELF.fetch(inboxUrl(inbox, "/messages/latest"), { headers: auth });
    const message = (await res.json()) as StoredMessage;
    expect(message.truncated).toBe(true);
    expect(message.text!.length).toBe(256);
  });
});

describe("push-notified wait", () => {
  it("returns a message that is already waiting", async () => {
    const inbox = "qa-wait-now@sodality.chat";
    await deliver({ to: inbox, subject: "Password reset" });

    const res = await SELF.fetch(inboxUrl(inbox, "/wait?timeout=5&subject=password"), { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as StoredMessage).subject).toBe("Password reset");
  });

  it("is woken by an arrival rather than a poll", async () => {
    const inbox = "qa-wait-push@sodality.chat";
    const pending = SELF.fetch(inboxUrl(inbox, "/wait?timeout=30&subject=late"), { headers: auth });

    // Give the request time to register itself with the Durable Object.
    await new Promise((r) => setTimeout(r, 300));

    const waiters = await SELF.fetch(inboxUrl(inbox, "/waiters"), { headers: auth });
    expect((await waiters.json()) as { waiters: number }).toMatchObject({ waiters: 1 });

    const sentAt = Date.now();
    await deliver({ to: inbox, subject: "late arrival" });

    const res = await pending;
    expect(res.status).toBe(200);
    expect(((await res.json()) as StoredMessage).subject).toBe("late arrival");

    // Woken by the notification, not by a poll interval.
    expect(Date.now() - sentAt).toBeLessThan(2000);
  });

  it("keeps waiting when a summary matches but the body filter does not", async () => {
    const inbox = "qa-wait-body@sodality.chat";
    const pending = SELF.fetch(inboxUrl(inbox, "/wait?timeout=30&contains=314159"), { headers: auth });
    await new Promise((r) => setTimeout(r, 300));

    await deliver({ to: inbox, subject: "Hello", text: "nothing useful here" });
    await new Promise((r) => setTimeout(r, 300));
    await deliver({ to: inbox, subject: "Hello", text: "Your code is 314159." });

    const res = await pending;
    expect(res.status).toBe(200);
    expect(((await res.json()) as StoredMessage).text).toContain("314159");
  });

  it("ignores messages at or before `since`", async () => {
    const inbox = "qa-wait-since@sodality.chat";
    await deliver({ to: inbox, subject: "old" });
    const cutoff = Date.now();

    const res = await SELF.fetch(inboxUrl(inbox, `/wait?timeout=1&since=${cutoff}`), { headers: auth });
    expect(res.status).toBe(408);
  });

  it("accepts `since` in epoch seconds as well as milliseconds", async () => {
    const inbox = "qa-wait-units@sodality.chat";
    await deliver({ to: inbox, subject: "seconds test" });

    const seconds = Math.ceil(Date.now() / 1000);
    const res = await SELF.fetch(inboxUrl(inbox, `/wait?timeout=1&since=${seconds}`), { headers: auth });
    // Read as seconds, this cutoff is in the future, so nothing matches.
    // Read as milliseconds it would be 1970 and the old message would match.
    expect(res.status).toBe(408);
  });

  it("times out with a 408 on an empty inbox", async () => {
    const res = await SELF.fetch(inboxUrl("qa-empty@sodality.chat", "/wait?timeout=1"), { headers: auth });
    expect(res.status).toBe(408);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "timeout" });
  });

  it("drops blocked waiters when the inbox is purged", async () => {
    const inbox = "qa-wait-purge@sodality.chat";
    const pending = SELF.fetch(inboxUrl(inbox, "/wait?timeout=30"), { headers: auth });
    await new Promise((r) => setTimeout(r, 300));

    await SELF.fetch(inboxUrl(inbox, "/messages"), { method: "DELETE", headers: auth });

    const res = await pending;
    expect(res.status).toBe(408);
  });
});

describe("diagnostics", () => {
  it("lists every inbox holding mail", async () => {
    await deliver({ to: "qa-diag-a@sodality.chat", subject: "a1" });
    await deliver({ to: "qa-diag-a@sodality.chat", subject: "a2" });
    await deliver({ to: "qa-diag-b@sodality.chat", subject: "b1" });

    const res = await SELF.fetch("https://qa/v1/inboxes", { headers: auth });
    const body = (await res.json()) as { inboxes: { inbox: string; count: number }[] };
    const byName = Object.fromEntries(body.inboxes.map((i) => [i.inbox, i.count]));
    expect(byName["qa-diag-a@sodality.chat"]).toBe(2);
    expect(byName["qa-diag-b@sodality.chat"]).toBe(1);
  });

  it("lists messages across all inboxes newest-first", async () => {
    await deliver({ to: "qa-all-1@sodality.chat", subject: "older" });
    await new Promise((r) => setTimeout(r, 5));
    await deliver({ to: "qa-all-2@sodality.chat", subject: "newer" });

    const res = await SELF.fetch("https://qa/v1/messages?limit=10", { headers: auth });
    const body = (await res.json()) as { messages: MessageSummary[] };
    expect(body.messages.slice(0, 2).map((m) => m.subject)).toEqual(["newer", "older"]);
    const timestamps = body.messages.map((m) => m.ts);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const res = await SELF.fetch("https://qa/v1/nope", { headers: auth });
    expect(res.status).toBe(404);
  });

  it("405s an unsupported method", async () => {
    const res = await SELF.fetch(inboxUrl("qa@sodality.chat", "/messages"), {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(405);
  });
});
