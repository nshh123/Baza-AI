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

## 12. Filling in missing assistant capabilities

Before opening the bot up to other users, reviewed the existing feature set and found
two real gaps: tasks/reminders could be created but never completed or cancelled
(despite the schema already supporting it), and `users.timezone` was declared but never
actually set or used, so Gemini only ever saw a raw UTC timestamp.

Added in one pass:
- `complete_task` / `cancel_reminder` tools, matching by title/message substring
  against the active list already given to Gemini as context.
- Real per-user timezones: a phone-number-based default guess (later replaced, see
  §17), the system prompt given the user's actual local time, and a `set_timezone`
  tool so the user can correct it conversationally.
- Recurring reminders (`daily` | `weekly` | `monthly`) — on dispatch, a recurring
  reminder reschedules to its next occurrence instead of being left `sent`. Needed a
  `reminders.recurrence` migration.
- Image understanding — WhatsApp images downloaded and passed to Gemini the same way
  voice notes already were (`processUserMessage`'s `audioBuffer` param generalized to
  `mediaBuffer`, used for both).

Discovered mid-testing: `gemini-flash-latest` currently resolves to `gemini-3.6-flash`,
which has only a **20 request/day** free quota — unusable for more than one user.
Switched the pinned model to `gemini-flash-lite-latest` (had quota available, and
tracks Google's newest lite release rather than a hardcoded version, avoiding the
hard-deprecation just hit on `gemini-2.0-flash`/`2.5-flash`).

## 13. Two bugs found by real user testing

- **Captionless images defaulted to describing instead of answering.** Sent a photo of
  exam questions with a caption ("here you go, answer these") and it correctly solved
  all four; sent one *without* a caption and it just described the image. Root cause
  was in our own system prompt, which explicitly told Gemini to default to describing
  when there's no caption — fixed to prioritize reading and answering/solving any
  legible questions/problems regardless of caption.
- **"Cancel my daily reminder" failed.** Traced to two things: (1) the actual trigger
  was the model narrating "reminder set" without calling the tool at all — retested in
  isolation and the underlying code was reliable (6/6 successful tool calls), so this
  was logged as an occasional LLM slip and mitigated with an explicit prompt rule never
  to claim an action without calling its tool; (2) a real, separate gap regardless:
  `cancelReminderByMessage` only matched against the reminder's `message` text, not its
  `recurrence` — "daily" doesn't appear in a message like "Stretch". Fixed to match
  either field.

## 14. WhatsApp's 4096-character limit

A detailed answer to solved exam questions (6,288 characters) was generated
successfully by Gemini and saved to conversation history, but silently failed to send
— WhatsApp's Cloud API hard-rejects any `text.body` over 4096 characters (HTTP 400),
with the only trace being a console error the user never saw. Fixed by having
`sendWhatsAppMessage` split any over-limit message into multiple sequential messages,
breaking at the last newline/space before the boundary where possible.

## 15. UX polish: readable times, task due dates, quick-reply buttons

- `src/utils/formatting.ts` — `formatFriendlyDateTime`/`formatTaskList`/
  `formatReminderList`, so confirmations show "Wed, Aug 12, 6:00 PM" instead of a raw
  UTC ISO string.
- `add_task` gained an optional `due_date_iso`, interpreted relative to the user's
  local time the same way reminder times are.
- Adding a task or reminder now sends a WhatsApp quick-reply button ("Daily Plan" /
  "My Reminders") alongside the confirmation. Tapping it is handled **deterministically**
  in `webhook.ts` — a direct DB read + formatted reply, no Gemini call — both faster
  and free-tier-friendlier. `processUserMessage` now returns `{ text, buttons? }`
  instead of a bare string.

## 16. Gemini congestion and a real latency fix

Hit `503 UNAVAILABLE` ("currently experiencing high demand") from Gemini's free-tier
API multiple times on plain, ordinary requests — confirmed transient by reproducing
the identical request outside the congestion window and having it succeed in ~2s.
Added `generateContentWithRetry()`: retries up to twice (1.5s, then 3s backoff)
specifically on that failure signature.

Separately (and independent of Gemini's mood): found every message was making 4
Supabase reads — memories, conversation history, tasks, pending reminders — one after
another before even calling Gemini, despite none of them depending on each other.
Parallelized with `Promise.all`, cutting that phase to the latency of the slowest
single read instead of their sum. A real, consistent latency win on every message.

## 17. Default timezone, first-time welcome, consistent self-introduction

- Replaced the phone-number-guessed timezone default with a fixed **Africa/Kigali**
  default per explicit request; removed `guessTimezoneFromPhone` and its calling-code
  table entirely (dead code once unused).
- `getOrCreateUser` now reports `isNewUser`; brand-new users get a one-time welcome
  message — *"I'm Baza AI — your personal AI assistant, accessible anytime right here
  on WhatsApp!"* — sent before their actual first message is processed.
- System prompt persona updated so Gemini answering "who are you" itself uses the same
  framing consistently.

## 18. Typing indicator

Added `sendTypingIndicator()` — marks the inbound message read with a
`typing_indicator` attached (Meta Cloud API), fired without blocking, in parallel with
the (sometimes several-second) actual processing. Only fired for text/audio/image
messages; button taps answer near-instantly and don't need it. Confirmed visible on a
real device.

## 19. App Review & Business Verification (in progress — see "Where things stand")

Walked through moving off the 5-recipient sandbox test number toward letting anyone
message the bot:

- Registered a real production phone number under a **new** WhatsApp Business Account
  ("Baza AI", WABA ID `1007180435703968`) — a different WABA from the original sandbox
  one (`4508606849414563`) used everywhere in §1–§11. Number: `+250 782 278 790`,
  Phone Number ID `1296582793529806`.
- The number just needed to receive **one SMS OTP** during registration — no
  smartphone or WhatsApp install required on the device at all; a cheap prepaid SIM in
  a basic phone was enough. After that, Cloud API hosts the number entirely
  server-side.
- Registered for Cloud API with a 2-step verification PIN, then subscribed webhooks.
  Checked whether this WABA had the same "subscribed to the wrong app" quirk as §3 —
  it didn't; correctly auto-subscribed to our own app this time.
- Added a payment method (required even to stay within free tiers, as an anti-abuse
  measure — adding one does not itself trigger a charge). No spending-limit/threshold
  option was found on this billing surface, unlike Meta Ads Manager.
- Pricing model as currently understood: regular replies (the bot responding to
  whatever a user sends) get 1,000 free user-initiated conversations/month; reminders
  and the daily digest are *business-initiated* and fall into a separate, smaller-free-
  allowance bucket.
- **Important compliance gap found**: WhatsApp's Cloud API rejects plain-text
  business-initiated messages sent more than 24 hours after the user's last message on
  *production* numbers. Reminders had only ever worked in testing because the sandbox
  test number doesn't enforce this — switching to the real number would have started
  silently failing any reminder/digest sent outside that window. See §20 for the fix.
- Created the `reminder_notification` Utility template via the dashboard. Two
  validation errors along the way, both fixed by editing the body text directly:
  variables must be named/lowercase-with-underscores (`{{reminder_message}}`, not
  positional `{{1}}`), and a variable can't be the last thing in the template (added
  trailing "— sent by Baza AI 🤖" text after it).
- Business Verification: business type "Private Company"; caught that the *legal*
  registered name belongs in "Business name" (Meta looks this up against official
  registry records) and the public-facing/trade name belongs in "Alternative business
  name" — had them backwards (legal name is "BazaDevSpace", trade name "Baza AI").
  Website field rejected the free `baza-ai-tech.vercel.app` subdomain (Meta requires an
  owned domain); user to buy a cheap domain and set up forwarding to the existing
  Vercel app rather than rebuilding anything. Government business registration is
  still pending as of this writing, which may block verification clearing until it's
  approved — but this **does not block current operation**: an unverified WABA still
  works on Meta's default messaging tier.

## 20. Template-based sending with graceful fallback

Added `sendWhatsAppTemplate()` to `whatsapp.ts` (sends a named-parameter-format
template). `checkAndDispatchReminders` now tries the `reminder_notification` template
first and falls back to the existing plain-text send if it fails (not yet approved, or
ever un-approved later) — safe to deploy regardless of the template's review status,
and starts using it silently the moment Meta approves it, no second deploy needed.
Verified end-to-end: template attempt correctly fails without throwing while pending,
falls back, reminder dispatched and marked `sent` successfully.

## 21. Daily digest — the standout feature

With remaining session time, built one feature meant to make Baza AI feel like a real
assistant rather than a reactive chatbot: a proactive "good morning" summary sent at
**8am in each user's own local time**, listing their active tasks and reminders.
Skips (but still marks as checked) users with nothing active, so nobody gets an empty
digest every morning.

- `users.last_digest_date` migration (`YYYY-MM-DD` of the last local date a digest was
  sent) prevents double-sends if cron ticks overlap.
- `getLocalDateAndHour(timezone)` (new, in `utils/timezone.ts`) computes a user's
  current local date/hour cleanly via `Intl`, avoiding DST/offset arithmetic bugs.
- `checkAndSendDailyDigests()` (`src/services/digest.ts`) checks every user each cron
  tick; fires once per user per local day when their local hour hits 8.
- New `daily_digest` template created **directly via the Business Management API**
  (`POST /{WABA-ID}/message_templates`) rather than the dashboard — Meta's
  auto-classifier tagged it **Marketing** instead of the requested Utility (doesn't
  block sending, just a smaller free allowance; could delete/recreate with adjusted
  wording later if that matters at scale). Same template-then-fallback pattern as §20.
- Wired into the same `runScheduledTasks()` both the internal cron and the external
  `/cron/check-reminders` endpoint already call — no new scheduled job needed.

Verified fully end-to-end against the real account: temporarily switched its timezone
to a real UTC+12 zone genuinely at 8am, seeded a task and a reminder, ran the real
check, confirmed a real digest was delivered (via the plain-text fallback, template
still pending) and `last_digest_date` recorded correctly, then reverted the account to
its exact original state with no leftover data.

## 22. Typing indicator missing on fast replies

User reported the typing indicator sometimes didn't show at all — distinct from the
25s keep-alive fix in the prior commit (§18), this happened even on the *first*
reply, and stood out most on quick queries like "hello". Root cause:
`sendTypingIndicator()` in `webhook.ts` was fired without `await`, racing against
`getOrCreateUser` + `processUserMessage` + `sendWhatsAppMessage`. For a fast reply,
the actual message could reach the Graph API before the typing-indicator request had
landed, so the client either never rendered it or the reply arrived and immediately
superseded it.

Fix: `await sendTypingIndicator(message.id)` for the initial call before any
processing starts, guaranteeing it's registered with WhatsApp first regardless of how
quickly the reply is generated. The 20s keep-alive interval is unchanged.

Confirmed by the user this got the ordering right but exposed the next layer of the
same problem: even *ordered* correctly, a reply generated in a few hundred ms still
reached WhatsApp too soon after the indicator request for the client to visibly
animate it — the reply just popped in after an unnaturally short pause. Added a
`MIN_TYPING_DISPLAY_MS` (1500ms) floor: after processing finishes, if less than that
has elapsed since the indicator was shown, wait out the remainder before sending the
reply. Normal (slower) replies are unaffected since the floor has usually already
elapsed by the time they're ready.

## Where things stand

**Live and working in production** (Render, auto-deploying from `main`, no local
process required):
- Conversation over text, voice notes, and images; long-term memory; tasks (with due
  dates, completion) and reminders (one-time and recurring, cancellable, matched by
  content or recurrence word).
- Timezone-aware scheduling, defaulting new users to Africa/Kigali until corrected.
- Human-readable confirmations, quick-reply buttons for viewing tasks/reminders, a
  typing indicator, and message chunking past WhatsApp's 4096-char limit.
- Resilience: webhook signature verification, message dedup, reminder-claim dedup
  (prevents duplicate sends from overlapping cron runs), Gemini retry-on-congestion,
  parallelized context fetching.
- A proactive daily digest at 8am local time per user.
- Reminders and the daily digest both attempt an approved WhatsApp template first and
  gracefully fall back to plain text — safe regardless of template approval status.

**Mid-way through Meta App Review / Business Verification — the concrete unfinished
pieces for whoever picks this up next:**

1. **The live bot has NOT been cut over to the new production number yet.**
   `.env`'s `META_PHONE_NUMBER_ID` still points at the original sandbox test number.
   The new number (`+250 782 278 790`, Phone Number ID `1296582793529806`, WABA
   `1007180435703968`) is registered, 2FA-verified, webhook-subscribed, and confirmed
   receiving correctly (a real message to it triggered our webhook; the reply just
   still comes from the old number since that's what's configured). **To complete the
   cutover**: update `META_PHONE_NUMBER_ID` to `1296582793529806` in `.env`/Render's
   environment variables and redeploy.
2. **Two message templates awaiting Meta review**: `reminder_notification` and
   `daily_digest`. Check status any time with:
   ```bash
   curl "https://graph.facebook.com/v21.0/1007180435703968/message_templates" \
     -H "Authorization: Bearer <token>"
   ```
   No code changes needed regardless of outcome — both already fall back to plain text
   safely.
3. **Business Verification** is submitted but likely blocked on: (a) the government
   business registration for "BazaDevSpace" still being pending approval, (b) needing
   a real owned domain for the website field (user was buying one next).
4. **Not yet explored in this session**: whether the app needs to be explicitly
   switched from Meta's "Development" mode to "Live" mode in the App Dashboard once
   verification clears, to allow messaging from users who aren't app admins/testers/
   developers. Worth checking Meta's current docs/UI for this app specifically before
   assuming App Review is fully done once the above items clear.
