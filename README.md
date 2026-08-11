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
   | `PORT` | Local port to run the server on (default `3000`) |
   | `META_VERIFY_TOKEN` | Any string you choose — used to verify the webhook handshake with Meta |
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

## Security

- **Webhook signature verification** — every POST to `/webhook` is validated against Meta's `X-Hub-Signature-256` header (HMAC-SHA256 over the raw body, keyed with `META_APP_SECRET`). Requests without a valid signature are rejected with `401`. If `META_APP_SECRET` isn't set, verification is skipped with a loud warning — don't run that way in production.
- **Duplicate delivery protection** — Meta retries webhook deliveries it can't confirm were received. Each message ID is atomically claimed in the `processed_messages` table before any processing happens, so retries are skipped rather than double-processed.

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
