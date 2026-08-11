# Baza AI

A WhatsApp personal assistant built entirely on free-tier infrastructure. Baza AI talks to users over WhatsApp, remembers facts about them, manages a daily task list, and sends reminders — all through natural conversation, powered by Gemini's function calling.

## Features

- **Natural conversation** over WhatsApp — text messages and voice notes
- **Long-term memory** — the assistant decides on its own when to save a preference, goal, or fact about the user, and recalls it in future conversations
- **Reminders** — schedule a one-time reminder in natural language; a background job dispatches it on WhatsApp at the right time
- **Daily task list** — add, track, and review tasks conversationally
- **Conversation history** — recent turns are fed back as context so replies stay coherent across a session

## Architecture

```
WhatsApp user
     │
     ▼
Meta Cloud API  ──POST──▶  /webhook  (Express)
                              │
                              │  1. Verify X-Hub-Signature-256 (HMAC-SHA256)
                              │  2. Claim message ID (skip if already processed)
                              │  3. Fetch user + memories + history + tasks (Supabase)
                              │  4. Ask Gemini 2.0 Flash, with tools:
                              │       save_memory · create_reminder · add_task · get_daily_plan
                              │  5. Persist any tool calls + the conversation turn
                              ▼
                    Meta Cloud API  ──▶  reply sent back to user

Background: a node-cron job polls `reminders` every minute and dispatches any that are due.
On a free-tier host that sleeps when idle, that internal tick can't fire while asleep —
an external scheduler hits `POST /cron/check-reminders` every minute instead, which both
wakes the service and runs the same dispatch logic. See [Deployment](#deployment).
```

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript, Express |
| AI / NLU | Gemini 2.0 Flash (`@google/genai`), function calling |
| Data | Supabase (Postgres) |
| Messaging | Meta WhatsApp Cloud API |
| Scheduling | `node-cron` |

## Project structure

```
src/
├── index.ts                  Express app, middleware, route wiring, scheduler startup
├── controllers/
│   └── webhook.ts            Meta webhook verification, signature check, message routing
├── services/
│   ├── gemini.ts              Conversation engine + tool declarations
│   ├── supabase.ts            All database access (users, memory, tasks, reminders, dedup)
│   ├── whatsapp.ts            Send messages / download media via Meta Graph API
│   └── scheduler.ts           Cron job that dispatches due reminders
└── types/
    └── index.ts               Shared types (DB rows, webhook payloads)
supabase_schema.sql            Postgres schema — run this in the Supabase SQL Editor
```

## Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project (free tier)
- A [Google AI Studio](https://aistudio.google.com) API key for Gemini
- A Meta developer app with the WhatsApp product added ([developers.facebook.com](https://developers.facebook.com))

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment variables** — copy `.env.example` to `.env` and fill in:

   | Variable | Where to get it |
   |---|---|
   | `PORT` | Local port to run the server on (default `3000`) — omit in production, most hosts inject their own |
   | `META_VERIFY_TOKEN` | Any string you choose — used to verify the webhook handshake with Meta |
   | `CRON_SECRET` | Any random string you choose — required by `POST /cron/check-reminders` (see [Deployment](#deployment)) |
   | `META_WHATSAPP_TOKEN` | Meta app → WhatsApp → API Setup (see [Access token](#access-token) below) |
   | `META_PHONE_NUMBER_ID` | Meta app → WhatsApp → API Setup |
   | `META_APP_SECRET` | Meta app → App Settings → Basic → App Secret |
   | `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com/apikey) |
   | `SUPABASE_URL` | Supabase project → Settings → API |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase project → Settings → API (service role, not anon) |

3. **Apply the database schema** — open the Supabase SQL Editor for your project and run the contents of `supabase_schema.sql`.

4. **Expose your local server to Meta** — Meta needs a public HTTPS URL to deliver webhooks to. For local development, use a tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

5. **Configure the webhook** in your Meta app dashboard (`WhatsApp → Configuration`, or `/apps/<app-id>/webhooks/`):
   - Callback URL: `https://<your-tunnel-url>/webhook`
   - Verify Token: same value as `META_VERIFY_TOKEN`
   - Subscribe to the `messages` field
   - **Important:** the WhatsApp Business Account must be explicitly subscribed to *your* app (`POST /{WABA-ID}/subscribed_apps`) — the guided setup doesn't always do this automatically. See [Troubleshooting](#troubleshooting).

## Running

```bash
npm run dev     # development, auto-restart on file changes
npm run build   # compile TypeScript to dist/
npm start        # run the compiled build
```

## Deployment

Local development uses a tunnel (`cloudflared`) so Meta can reach your machine, but a
tunnel dies whenever that process stops — it's fine for testing, not for anything meant
to run unattended. Production uses free-tier hosting instead:

1. **Host the server** — e.g. [Render](https://render.com), free tier:
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
   - Add every variable from the [environment variables](#setup) table above **except**
     `PORT` (the host injects its own).
   - Once deployed, update the Meta webhook Callback URL (see step 5 above) to your
     host's permanent URL, e.g. `https://your-app.onrender.com/webhook`.

2. **Keep reminders firing while the host sleeps** — free web services on most hosts
   spin down after a period of inactivity, which stops the internal `node-cron` tick
   along with everything else. An external scheduler works around this: it hits
   `POST /cron/check-reminders` once a minute, which wakes a sleeping service *and*
   triggers the same reminder-dispatch logic in one request.
   - Sign up at [cron-job.org](https://cron-job.org) (free, supports 1-minute intervals).
   - Create a job: URL = `https://your-app.onrender.com/cron/check-reminders`,
     method **POST**, schedule **every 1 minute**.
   - Under the job's Advanced tab, add a header: `x-cron-secret` = your `CRON_SECRET`
     value. Requests without a matching header get `401`.

   Because the free host can be slow to wake from sleep, cron ticks can end up
   overlapping (e.g. a request queues behind a cold start that takes longer than the
   1-minute interval). To stay safe under that, each reminder is **atomically claimed**
   (a conditional `pending → sent` update) before it's sent — see
   `claimReminder()` in `src/services/supabase.ts` — so only one overlapping run can
   ever send a given reminder. A failed send reverts the claim back to `pending` so
   it's retried on the next tick instead of being lost.

## Security

- **Webhook signature verification** — every POST to `/webhook` is validated against Meta's `X-Hub-Signature-256` header (HMAC-SHA256 over the raw body, keyed with `META_APP_SECRET`). Requests without a valid signature are rejected with `401`. If `META_APP_SECRET` isn't set, verification is skipped with a loud warning — don't run that way in production.
- **Duplicate delivery protection** — Meta retries webhook deliveries it can't confirm were received. Each message ID is atomically claimed in the `processed_messages` table before any processing happens, so retries are skipped rather than double-processed.
- **Duplicate reminder protection** — see [Deployment](#deployment); reminders are atomically claimed before sending so overlapping cron runs can't send the same one twice.

## Access token

The token you get from the WhatsApp "Try it out" quick-start page expires after 24 hours. For anything beyond a quick test, generate a **permanent token** via a System User:

1. Go to [business.facebook.com/settings](https://business.facebook.com/settings) → **Users → System Users**.
2. Add a system user (role: Admin) if you don't have one.
3. **Add Assets** → assign your app *and* your WhatsApp Business Account to it with full control.
4. Back on the system user, **Generate New Token** → select your app → check `whatsapp_business_messaging` and `whatsapp_business_management` → expiration: **Never**.
5. Copy the token into `META_WHATSAPP_TOKEN`. It won't expire unless revoked.

## Troubleshooting

**Webhook is verified but no messages arrive** — the WhatsApp Business Account may be subscribed to a different app (a known quirk of the test-number quick-start flow). Check with:
```bash
curl "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" \
  -H "Authorization: Bearer <META_WHATSAPP_TOKEN>"
```
If your app isn't listed, subscribe it:
```bash
curl -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" \
  -H "Authorization: Bearer <META_WHATSAPP_TOKEN>"
```

## License

MIT
