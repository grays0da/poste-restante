# Poste-Restante

Disposable email inboxes for test automation, on Cloudflare.

An Email Worker catches every message sent to a domain you own, stores it in Workers KV with a TTL, and a bearer-authenticated HTTP API lets a test block until the mail it triggered arrives — woken by a Durable Object the moment the message lands, not by polling.

sender ──SMTP──▶ Email Routing ──▶ email() ──▶ KV (TTL) ──notify──▶ InboxNotifier (DO)
                                                                          │ push
test harness ──GET /v1/inboxes/:addr/wait───────────────────────────────▶ fetch()
ts
const inbox = mail.newInbox("login");            // qa-login-9f2a1c3d@example.com
await requestLoginLink(inbox.address);
const msg = await inbox.waitFor({ subject: "log in", timeoutSeconds: 300 });
const link = firstLink(msg.html ?? msg.text ?? "");

No mailbox to provision, no IMAP client in your test suite, no addresses to register — invent one per test run and it works.

What this is for

Testing flows that send real mail: signup confirmation, password reset, magic links, order confirmations, OTP codes. It was built to test Shopify storefront flows, where the login mail can take anywhere from seconds to five minutes.

How it differs from MailHog, Mailpit, MailCatcher, smtp4dev and friends: those run a local SMTP server, so the sender has to be configured to deliver to them. This holds a real domain with real MX records, so it tests mail that genuinely leaves the sender's infrastructure and traverses public SMTP — which is the thing you actually want to assert on when the sender is a third party you don't control.

What it is not: a mail client, a deliverability tool, or anything to put in front of mail you care about keeping. Messages expire on a TTL and ingest is open by design.

Quick start
bash
npm install

# 1. KV namespace — copy the printed id into wrangler.jsonc
npx wrangler kv namespace create QA_MAIL

# 2. API token (write-only once set; to rotate, just set a new one)
openssl rand -hex 32
npx wrangler secret put API_TOKEN

# 3. Deploy — this also applies the Durable Object migration
npx wrangler deploy

Then point a domain at it: Cloudflare dashboard → your zone → Email → Email Routing → enable it (Cloudflare adds the MX/SPF records) → Routing rules → Catch-all address → action Send to a Worker → qa-email-worker → save and enable it.

A new zone's catch-all defaults to Drop and is switched off. Enabling Email Routing does not enable it. This is the single most common reason mail never shows up.

Two more things worth knowing:

Email Routing takes over inbound mail for the whole zone. If you want real mail at you@yourdomain, add a specific address rule forwarding it to a real mailbox — specific rules are evaluated before the catch-all.
Verify the zone in the dashboard before testing; mail to an unverified zone is rejected at SMTP time and never reaches the worker.

Set MAIL_DOMAIN in wrangler.jsonc to the domain you connected.

Why a Durable Object

The first version polled KV on an interval. A 5-minute wait at 500ms cost ~600 list operations — and the mail this was built to test routinely takes minutes, so polling was the dominant cost of the whole service.

Now a wait registers itself with a Durable Object keyed by idFromName(inbox), and the email handler calls notify() after the KV write. Measured locally: a 10-second wait satisfied by an arrival logged lists: 1, notifications: 1 — one KV list operation, and the request returned ~14ms after the mail landed.

	polling (500ms)	push
60s wait	~120 list ops	~1–2 list ops
5min wait	~600 list ops	~1–2 list ops per 60s window

The DO holds no data. KV stays the source of truth; the object holds only the in-memory set of blocked requests plus a 50-entry ring buffer of recent arrivals, which closes the race where mail lands between a caller's own KV check and its registration. If the object is evicted mid-wait the blocked requests are lost — so every wait ends with one closing list call as a safety net. A lost notification therefore costs latency, never a missed message.

Durable Objects are on the Workers Free plan as long as the class is SQLite-backed (new_sqlite_classes in the migration), which is why the migration is written that way even though nothing is stored. Free tier includes 100,000 DO requests and 13,000 GB-s of duration per day; a 5-minute held request costs roughly 37 GB-s, so a few hundred long waits a day fit comfortably.

If duration ever becomes the binding constraint, the next lever is a WebSocket with the hibernation API: the DO sleeps while waiting and is not billed for duration at all. It needs a WebSocket client in the harness, so it is not worth it until the HTTP version actually hurts.

Design decisions
Decision	Choice
Storage	KV only — one entry per message, native TTL expiry
Addressing	True catch-all: any address on the domain, invented per test run
Auth	Static bearer token (API_TOKEN secret)
Retrieval	REST + a push-notified wait endpoint
Notification	One Durable Object per inbox, in-memory, KV as source of truth
Cleanup	KV expirationTtl — no cron, no sweeper

Keys are laid out so a listing is already newest-first and needs no value reads:

msg:<inbox>:<invertedTimestamp>:<id>   -> StoredMessage JSON, metadata = MessageSummary
id:<id>                                -> the msg key above

invertedTimestamp is 9999999999999 - receiptMs, zero-padded. Listing and filtering run off KV metadata, so GET /messages costs one list operation, not N reads.

Timestamps

ts is epoch milliseconds (JavaScript Date.now()). Java's Instant.now().getEpochSecond() and Postman's {{$timestamp}} are epoch seconds — three digits shorter.

Every message also carries receivedAt, an ISO-8601 string for the same instant. Prefer it: Instant.parse(msg.receivedAt) has no unit ambiguity.
The since query param accepts either unit. Anything below 1e11 is read as seconds and scaled up (1e11 ms is 1973; 1e11 s is the year 5138), so a seconds value can no longer silently mean "since 1970" and match everything.
API

All /v1/* routes require Authorization: Bearer $API_TOKEN. :address is URL-encoded (qa-x%40example.com).

Method	Path	Notes
GET	/health	No auth. Liveness only.
GET	/v1/inboxes	Diagnostic: every inbox currently holding mail
GET	/v1/messages?limit=	Diagnostic: all mail, every inbox, newest-first
GET	/v1/inboxes/:address/messages?limit=&since=	Newest-first summaries
GET	/v1/inboxes/:address/messages/latest	Full newest message
GET	/v1/inboxes/:address/wait?...	Push-notified long-poll, see below
GET	/v1/inboxes/:address/waiters	Diagnostic: blocked requests on this inbox
DELETE	/v1/inboxes/:address/messages	Purge an inbox (also drops its waiters)
GET	/v1/messages/:id	Full message
DELETE	/v1/messages/:id	Delete one message
wait

Query params: timeout (seconds, default 30, capped by MAX_WAIT_SECONDS), since (ms or seconds — only mail received strictly after it counts), from, subject, contains (searches subject + text + html), hasAttachment.

Returns:

200 with the full message, plus an x-waited-ms header
408 {"error":"timeout", ...} if nothing matched before the deadline

Matching is case-insensitive substring, not exact. subject=confirm matches "Please Confirm Your Account"; from=shopify matches noreply@shopify.com.

from, subject and hasAttachment are evaluated inside the DO from list metadata, where the subject is clipped to 300 characters to stay under KV's 1024-byte metadata cap — a substring appearing only past character 300 of a very long subject will not match. contains reads the stored message, so it sees the full untruncated subject plus both bodies. A notification that matches on metadata but fails the body check does not end the wait; the request keeps waiting with its cursor advanced past that message.

Subjects are matched post-decoding: postal-mime unfolds and decodes RFC 2047 encoded-words before storage, so =?utf-8?B?...?= headers match on their readable text.

bash
BASE=https://qa-email-worker.<your-subdomain>.workers.dev
TOKEN=...

curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/inboxes/qa-1234%40example.com/wait?timeout=60&subject=confirm"
From a test suite

examples/qa-mail-client.ts is a dependency-free client that chains wait windows, so a 5-minute login mail is one call:

ts
import { QaMail, firstLink, firstCode } from "./qa-mail-client";

const mail = new QaMail({
  baseUrl: process.env.QA_MAIL_URL!,
  token: process.env.QA_MAIL_TOKEN!,
  domain: "example.com",
});

const inbox = mail.newInbox("login");           // qa-login-9f2a1c3d@example.com
await requestLoginLink(inbox.address);

const msg  = await inbox.waitFor({ subject: "log in", timeoutSeconds: 300 });
const link = firstLink(msg.html ?? msg.text ?? "");
const code = firstCode(msg.text ?? "");
Configuration

Everything lives in wrangler.jsonc vars, except the token:

Var	Default	Meaning
MAIL_DOMAIN	—	The domain you connected; appears in /health and logs
RETENTION_SECONDS	86400	KV TTL per message (min 60)
MAX_EMAIL_BYTES	5242880	Larger mail is stored as a metadata-only stub
MAX_BODY_CHARS	262144	text/html truncation point
STORE_ATTACHMENT_MAX_BYTES	0	0 = keep attachment metadata only
MAX_WAIT_SECONDS	60	Ceiling on a single wait call
MAX_MIME_PARTS	200	Parser part cap; inbound mail is untrusted
ALLOWED_RECIPIENT_PATTERN	""	Optional regex; empty = accept everything
LOG_LEVEL	info	debug | info | warn | error
API_TOKEN (secret)	—	Bearer token for every /v1/* route

compatibility_date is pinned to what the miniflare bundled with @cloudflare/vitest-plugin supports. Bump it and that package together, or the local test runtime refuses to start.

Local development
bash
cp .dev.vars.example .dev.vars     # sets API_TOKEN for local runs
npx wrangler dev

wrangler dev exposes /cdn-cgi/handler/email, which invokes the email() handler with a raw MIME body — no real mail needed:

bash
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=noreply@shop.example' \
  --url-query 'to=qa-local@example.com' \
  --header 'Content-Type: application/json' \
  --data-binary $'From: noreply@shop.example\r\nTo: qa-local@example.com\r\nSubject: Verify\r\nMessage-ID: <1@shop.example>\r\n\r\nYour code is 481516.\r\n'

To watch the push path work: start a wait with a long timeout, check /v1/inboxes/<addr>/waiters (should report waiters: 1), then deliver mail and see the wait return immediately with lists: 1 in the log line.

bash
npm run typecheck
npm test          # 23 tests, including the DO wake-up and body-filter paths
npm run tail      # structured logs from the deployed worker
Test tooling

@cloudflare/vitest-pool-workers was renamed to @cloudflare/vitest-plugin; the old name is frozen and its pinned miniflare/wrangler drag in sharp, undici and zod advisories. This project uses the new package. npm audit reports 0 vulnerabilities, and the tree dedupes to one miniflare, one wrangler, one workerd and one esbuild.

Do not run npm audit fix --force against the old name: npm "fixes" it by downgrading the plugin to 0.12.21, which predates the cloudflareTest() plugin API and breaks the test config.

On npm 12, workerd and esbuild postinstall scripts are gated behind allowScripts and are skipped with a warning. They download required native binaries, so approve them or neither the test runner nor wrangler dev will start:

bash
npm install-scripts approve workerd esbuild
npm install
When mail does not show up

Work down this list — each step says which side of the boundary the problem is on.

Email → Email Routing → Activity log. It logs every message the zone received and what happened to it. Not listed at all → it never reached Cloudflare (DNS, step 3). Listed as dropped → catch-all (step 2).
Routing rules → Catch-all address. Must be enabled, with action Send to a Worker. Check specific address rules too; they win over the catch-all.
DNS. dig MX yourdomain must return route1.mx.cloudflare.net / route2 / route3.
npx wrangler tail, then send a test mail. An invocation line means the worker ran; no line means mail is not being routed to it.
Check for a bounce. A delivery failure notice means rejection at SMTP time rather than a silent drop, and the bounce text names which.
GET /v1/inboxes. Finds mail that arrived under an address you did not expect (envelope recipient differing from the To: header, plus-addressing, a typo'd alias). Empty here and an empty KV namespace means nothing was ever stored.
Operational notes
Exceptions are never swallowed. Every catch logs a structured JSON line with the serialized error and its cause chain. Storage failures in the email handler are logged and rethrown, so a failed delivery shows up in Workers metrics; parse failures store a stub record with parseError set so a test sees the arrival instead of timing out blind; a failed notify() is logged and swallowed on purpose, because the closing list call covers it.
The shipped bundle is src/ plus postal-mime. Everything npm audit has flagged historically lived in the test tooling, which never reaches the Worker — still worth keeping clean, since it runs on your machine and in CI.
Inbound mail is attacker-controlled. postal-mime is pinned to 4.x: 3.x has a high-severity advisory (quadratic CPU on crafted RFC 2047 headers), which on an open catch-all is a CPU-exhaustion vector. Parser limits (maxPartCount, maxHeadersSize, maxNestingDepth) are set explicitly rather than left at defaults.
otp is not authenticated. postal-mime 4.2 parses the sender's OTP-Token header into message.otp. Convenient for assertions, never a security control — the sender sets it and nothing verifies it.
Anyone can send to a catch-all domain. The API is token-protected, but ingest is open by definition. Set ALLOWED_RECIPIENT_PATTERN (e.g. ^qa-) once your address convention is settled, and keep retention short.
KV is eventually consistent. The push path makes this mostly moot for arrival latency, but a list immediately after a write can still lag.
Use a domain you do not need for real mail. Email Routing claims the whole zone's inbound mail.
Layout
src/index.ts     entry point: fetch() + email() + the DO export
src/email.ts     ingest: parse (postal-mime), normalise, store, notify
src/inbox-do.ts  InboxNotifier — one DO per inbox, notification bus only
src/api.ts       auth, routing, push-notified wait
src/filter.ts    filter shape shared by the API and the DO
src/store.ts     KV key layout and access
src/config.ts    env parsing with logged fallbacks
src/log.ts       structured logging + error serialization
test/            23 tests via @cloudflare/vitest-plugin
examples/        dependency-free client for your test harness
License
