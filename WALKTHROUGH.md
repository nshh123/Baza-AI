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

## Where things stand

- Webhook signature verification and message dedup are both live and tested.
- Access token no longer expires.
- Full pipeline (WhatsApp → webhook → Gemini → Supabase → WhatsApp reply) confirmed
  working with real messages.
- Still open, lower priority: the local dev tunnel (`trycloudflare.com`) has no uptime
  guarantee and isn't meant for anything beyond testing — a stable host/tunnel is
  needed before this goes further than local development.
