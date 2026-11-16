import { handleRequest } from "./api";
import { handleEmail } from "./email";
import { createLogger } from "./log";
import type { Env } from "./types";

export { InboxNotifier } from "./inbox-do";

/**
 * QA email service for sodality.chat.
 *
 *   email()  - catch-all ingest: parse inbound mail, store it in KV, notify waiters
 *   fetch()  - bearer-auth REST API + push-notified `wait` endpoint
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      // handleRequest has its own catch-all; this is the last line of defence
      // so a thrown error is never returned as an opaque runtime failure.
      createLogger(env.LOG_LEVEL, { component: "entry" }).exception(
        err,
        "unhandled error escaped the API handler",
        { url: request.url, method: request.method },
      );
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    // handleEmail logs and rethrows storage failures on purpose: a rethrow is
    // what surfaces the failure in Workers metrics and `wrangler tail`.
    await handleEmail(message, env, ctx);
  },
} satisfies ExportedHandler<Env>;
