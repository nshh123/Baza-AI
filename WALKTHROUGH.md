# Walkthrough: Getting Baza AI Live

This documents what was reviewed, broken, diagnosed, and fixed while taking Baza AI
from an unreviewed codebase to a working, git-tracked, end-to-end WhatsApp assistant.

## 1. Initial codebase review

Read through the full source tree and ran `tsc --noEmit` (clean) against the existing
implementation — a webhook controller, a Gemini function-calling engine, a Supabase data
layer, a WhatsApp send/media service, and a cron-based reminder scheduler. All `.env`
credentials were already populated with real (non-placeholder) values.

Findings from that first pass:

- **No webhook signature verification** — anyone who found the webhook URL could post
  fake events. *(fixed — see §5)*
- **Not yet a git repository**, despite having a `.gitignore`. *(fixed — see §7)*
- **RLS enabled with no policies** on every table — harmless while using the
  `SUPABASE_SERVICE_ROLE_KEY` (which bypasses RLS), but would silently block everything
  if an anon-key client were ever added.
- **No dedup on inbound message IDs** — a Meta webhook retry could double-process a
  message. *(fixed — see §6)*
- Tool-call replies are hardcoded strings appended after execution rather than fed back
  to Gemini for a natural follow-up — a deliberate simplification, not a bug.

## 2. Local dev environment: exposing the server to Meta

Meta needs a public HTTPS URL to deliver webhooks to; `localhost:3000` isn't reachable
from Meta's servers.

- `ngrok` was installed but not authenticated on this machine (`ERR_NGROK_4018`) —
  requires an ngrok account, so it was dropped.
- Switched to `cloudflared tunnel --url http://localhost:3000` (no account needed for a
  quick tunnel). This produced the public URL used for all webhook testing.
- The quick tunnel dropped and reconnected a few times over the session (`trycloudflare.com`
  quick tunnels have no uptime guarantee) — each drop required restarting the tunnel and
  updating the Callback URL in the Meta dashboard.

## 3. Wiring up the Meta webhook

Several rounds of trial and error before the webhook actually delivered anything:

1. **Wrong page** — the "Try it out" quick-start tab isn't where webhooks are
   configured; that lives under a separate **Webhooks** section of the app dashboard
   (`developers.facebook.com/apps/<app-id>/webhooks/`).
2. **Wrong object type** — the webhooks page defaults to the **User/Page** object
   (fields like `birthday`, `email`, `likes`), not **WhatsApp Business Account**. Had to
   switch the object dropdown before the right fields (`messages`, etc.) appeared.
3. **Stale callback URL** — after a tunnel restart, the Callback URL saved in Meta's
   dashboard pointed at a dead tunnel subdomain that didn't match the one actually
   running locally. Fixed by re-verifying with the current tunnel URL each time it
   changed.
4. **Outbound vs. inbound confusion** — the dashboard's "Send a message" test button
   sends **from** the business number **to** you (testing Meta → phone delivery); it
   never touches our webhook. Only a message sent **from your own WhatsApp app to the
   test number** exercises the `/webhook` endpoint.
5. **Root cause of "no replies"** — even with everything above correct, messages still
   never arrived. Diagnosis:
   ```bash
   curl "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <token>"
   ```
   showed the WhatsApp Business Account was subscribed to a Meta system app
   (`WA DevX Webhook Events 1P App`), **not** to Baza AI — a known quirk of the
   "Try it out" test-number flow, which doesn't always auto-subscribe your own app.
   Fixed with:
   ```bash
   curl -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <token>"
   ```
   After this, real WhatsApp messages started reaching the server.

## 4. Diagnosing a silent hang

At one point the pipeline accepted a message, logged it, and then never responded —
no error, no crash, no reply. Isolated with targeted timing instrumentation
(temporary `console.log` timestamps around each `await` in `gemini.ts` and
`webhook.ts`, later removed):

- Supabase and Gemini calls tested **in isolation** (fresh `node -e` processes)
  completed in well under a second.
- The **same calls inside the long-running `ts-node-dev` process** hung indefinitely.

Conclusion: a stale/poisoned connection in the long-running process, most likely from
the brief network drops seen in the tunnel logs around the same time. Restarting the
dev server cleared it — the full pipeline then completed in ~5 seconds end-to-end
(Gemini reply generated, WhatsApp send returned `true`).

## 5. Webhook signature verification

Added HMAC-SHA256 verification of Meta's `X-Hub-Signature-256` header:

- `src/index.ts` — `express.json()` now captures the raw request body (`req.rawBody`)
  via its `verify` option, since signature verification needs the exact bytes Meta
  signed, not the re-serialized parsed object.
- `src/controllers/webhook.ts` — new `verifyWebhookSignature` middleware computes
  `HMAC-SHA256(rawBody, META_APP_SECRET)` and compares it to the header using
  `crypto.timingSafeEqual`. Mismatches (or a missing signature) return `401`. If
  `META_APP_SECRET` isn't set, it fails **open** with a loud warning, so local testing
  before the secret was configured wasn't blocked.
- `META_APP_SECRET` (from Meta app → App Settings → Basic) added to `.env` / `.env.example`.
- Verified with `openssl dgst -sha256 -hmac` to confirm unsigned requests get `401` and
  correctly-signed ones get `200`.

## 6. Duplicate webhook delivery protection

Meta retries a webhook POST it can't confirm was received, which could re-run the
whole pipeline (duplicate memory writes, duplicate replies) for the same message.

- New `processed_messages` table (`message_id TEXT UNIQUE`) in `supabase_schema.sql`
  — applied manually via the Supabase SQL Editor, since only the REST/service-role key
  was available (no direct Postgres connection to run migrations from the app).
- `claimMessageId()` in `supabase.ts` atomically inserts the message ID before any
  processing begins; a unique-constraint violation (`23505`) means it's a retry and is
  skipped. Any other DB error fails **open**, so a transient outage never silently
  drops a real message.
- `webhook.ts` calls this immediately after logging the incoming message and returns
  early (before touching Supabase, Gemini, or WhatsApp) if it's a duplicate.
- Verified by sending the identical signed payload twice: the first was processed, the
  second was logged and skipped (`⏭️ Skipping duplicate webhook delivery`), and exactly
  one row landed in `processed_messages`.

## 7. Git and GitHub

The project had no git history. Initialized and pushed to the user's private GitHub
repo (`github.com/nshh123/Baza-AI`) as a sequence of logical commits rather than one
dump:

1. `chore: initial project scaffolding`
2. `feat: add data model and Supabase persistence layer`
3. `feat: add WhatsApp Cloud API integration`
4. `feat: add Gemini conversational engine with function calling`
5. `feat: add WhatsApp webhook controller` (already included signature verification)
6. `feat: add reminder scheduler and Express entrypoint`
7. `fix: skip duplicate webhook deliveries`
8. `docs: add README`

`.env` was confirmed excluded via `.gitignore` before the first commit — no secrets
were ever staged.

## 8. Permanent access token

The token from the "Try it out" quick-start expires every 24 hours, requiring a manual
swap into `.env` each time it lapsed (happened twice during this session). Replaced
with a permanent System User token:

1. Created a System User in Business Settings (`business.facebook.com/settings` →
   Users → System Users).
2. Assigned two assets to it with full access: the **Baza AI** app ("Manage app") and
   the **WhatsApp Business Account** ("Everything").
3. Generated a token scoped to `whatsapp_business_messaging` and
   `whatsapp_business_management`, expiration **Never**.
4. Verified via the Graph API debug endpoint before relying on it:
   ```bash
   curl "https://graph.facebook.com/debug_token?input_token=<token>&access_token=<app_id>|<app_secret>"
   ```
   Confirmed `"type": "SYSTEM_USER"` and `"expires_at": 0`.
5. Swapped into `META_WHATSAPP_TOKEN` and restarted the server; re-verified the phone
   number lookup and tunnel both still worked.

## 9. Moving off the local tunnel: production hosting

The `trycloudflare.com` quick tunnel used for local testing has no uptime guarantee and
dies whenever the tunnel process or the laptop it's running on stops — the reminder
scheduler and every inbound message depend on it staying up, which isn't viable
unattended. Replaced with:

- **Render** (free web service) hosting the app itself. Connected to the
  `github.com/nshh123/Baza-AI` repo, auto-deploying on push to `main`. Build command
  `npm install && npm run build`, start command `npm start`. All secrets from `.env`
  added as environment variables except `PORT`, which Render injects itself.
- The Meta webhook Callback URL was updated from the tunnel URL to the permanent Render
  URL (`https://baza-ai-dx2v.onrender.com/webhook`) — verified successfully, and a
  follow-up "Hello" message confirmed the full pipeline works through Render with no
  local process involved.

One dashboard question worth noting: Meta's webhook config page offers an "Attach a
client certificate to Webhook requests" toggle (mutual TLS). Left off — it's a separate
authenticity mechanism from the `X-Hub-Signature-256` check already implemented (§5),
and the server isn't configured to validate a client cert, so enabling it would add no
real protection without matching server-side support.

## 10. Keeping reminders firing on a sleeping free host

Render's free tier spins the service down after a period of inactivity, which stops the
internal `node-cron` tick along with everything else — reminders would silently stop
firing whenever nobody was actively messaging the bot.

Fix: added `POST /cron/check-reminders` (`src/index.ts`), guarded by a shared
`CRON_SECRET` header check, that runs the same dispatch logic the internal cron uses
(`checkAndDispatchReminders()`, extracted from `scheduler.ts` so both paths share one
implementation). An external scheduler — [cron-job.org](https://cron-job.org) (free,
1-minute intervals) — hits that endpoint every minute. The incoming request both wakes
a sleeping Render instance and triggers the reminder check in the same call, so no
separate "keep-alive ping" is needed.

Verified end-to-end in production: sent "remind me in 2 minutes to test the cron job"
over WhatsApp, watched the resulting `reminders` row in Supabase flip from `pending` to
`sent` right on schedule, confirmed by the reminder actually arriving on WhatsApp.

## 11. Bug found in production: duplicate reminder sends

After the above went live, a single reminder was delivered **four times**. Root cause:
`checkAndDispatchReminders()` fetched all due (`pending`) reminders, sent each one, and
only *then* marked it `sent` — no atomic claim in between. Render's free tier can take
tens of seconds to wake from a cold start, longer than cron-job.org's 1-minute interval,
so multiple triggered runs ended up overlapping in-flight. Each overlapping run saw the
same reminder as still `pending` before any of them had finished marking it `sent`, so
each sent it independently — the same class of bug already fixed for webhook messages
in §6, just not yet applied to reminders.

Fix: `claimReminder()` in `supabase.ts` now does a conditional update
(`UPDATE reminders SET status='sent' WHERE id=? AND status='pending'`) before sending;
only the run that actually flips the row wins the claim, and losers skip sending
entirely. A failed send reverts the claim back to `pending` (`revertReminderToPending()`)
so it retries on the next tick rather than being lost. Verified by firing 4 concurrent
claim attempts at the same test reminder — exactly 1 won.

## Where things stand

- Webhook signature verification and message dedup are both live and tested.
- Access token no longer expires (permanent System User token).
- Hosted permanently on Render, auto-deploying from `main` — no local process required.
- Reminders keep firing while the host sleeps, via an external cron trigger, with
  duplicate-send protection for overlapping runs.
- Full pipeline (WhatsApp → webhook → Gemini → Supabase → WhatsApp reply, and the
  reminder dispatch path) confirmed working entirely in production, with no dependency
  on the local machine.
