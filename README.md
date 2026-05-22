# Ecohotel Pure — WhatsApp AI Agent

A WhatsApp chatbot for **Ecohotel Pure** (San Carlos, Antioquia) that answers customer questions, provides accommodation and pricing information, and automatically notifies hotel staff via email when a guest is ready to make a reservation.

---

## How it works

```
Guest (WhatsApp)
      │
      ▼
Meta Cloud API  ──webhook──►  Express server (server.js)
                                      │
                              ┌───────┴────────┐
                              │                │
                         Supabase          Gemini 2.5 Flash
                    (conversation history)  (AI response + tool calls)
                                                │
                                    escalate_to_human tool
                                                │
                                           Resend API
                                        (email to hotel staff)
```

1. A guest sends a WhatsApp message.
2. Meta delivers it to the `/webhook` endpoint via HMAC-signed POST.
3. The server deduplicates the message against Supabase (handles Vercel's multi-instance nature) and checks rate limits.
4. The last 10 messages of the conversation are fetched and sent to Gemini as context.
5. Gemini responds as the hotel's virtual assistant. If the guest provides their name, arrival/departure dates, and number of people, Gemini calls the `escalate_to_human` function.
6. The server catches the function call, sends a formatted email to hotel staff via Resend, and feeds the result back to Gemini so it generates a natural confirmation message.
7. The reply is sent back to the guest over WhatsApp.

---

## Features

- Natural conversation in Spanish powered by Gemini 2.5 Flash
- Full knowledge of accommodations, pricing, food menu, directions, and hotel rules
- Automatic reservation escalation — collects guest info and emails hotel staff
- Conversation history (last 10 messages) for contextual replies
- Webhook signature verification (HMAC-SHA256) to reject spoofed requests
- Message deduplication via Supabase (safe for serverless/Vercel)
- Per-phone rate limiting (10 messages/minute)
- Bot kill-switch via `BOT_ACTIVE` env variable — disables the bot without taking the server down
- Deployable to Vercel with zero config changes

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| AI | Google Gemini 2.5 Flash (`@google/generative-ai`) |
| Database | Supabase (PostgreSQL) |
| Messaging | Meta WhatsApp Cloud API v21.0 |
| Email | Resend |
| Deployment | Vercel (serverless) |

---

## Prerequisites

- A [Meta Developer](https://developers.facebook.com/) account with a WhatsApp Business app
- A [Google AI Studio](https://aistudio.google.com/) account for the Gemini API key
- A [Supabase](https://supabase.com/) project
- A [Resend](https://resend.com/) account (free tier: 3,000 emails/month)
- Node.js 18 or higher
- [ngrok](https://ngrok.com/) (for local development only)

---

## Setup

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd wppdemocc
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root:

```env
# Meta / WhatsApp
WHATSAPP_ACCESS_TOKEN=<permanent or temporary token from Meta App Dashboard>
WHATSAPP_PHONE_NUMBER_ID=<Phone Number ID from Meta App Dashboard>
WHATSAPP_VERIFY_TOKEN=<any secret string you choose — used once to verify the webhook>
WHATSAPP_APP_SECRET=<App Secret from Meta App Dashboard → Basic Settings>

# Google Gemini
GEMINI_API_KEY=<API key from Google AI Studio>

# Supabase
SUPABASE_URL=<Project URL from Supabase dashboard>
SUPABASE_SERVICE_ROLE_KEY=<Service role key — NOT the anon key>

# Resend (email notifications)
RESEND_API_KEY=<API key from resend.com>
ESCALATION_EMAIL=<email address that receives reservation alerts>

# Optional
BOT_ACTIVE=true   # set to "false" to silence the bot without stopping the server
PORT=3000
```

### 3. Run the database migration

Open your Supabase project, go to **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it. This creates three tables:

| Table | Purpose |
|---|---|
| `conversations` | One record per unique phone number |
| `messages` | Every message (user + assistant) with timestamps |
| `processed_messages` | Deduplication log — entries older than 10 min are auto-deleted |

### 4. Start the server locally

```bash
npm run dev    # auto-restart on file changes (Node 18+ --watch)
# or
npm start      # production mode
```

The server starts on `http://localhost:3000`.

### 5. Expose the server with ngrok

```bash
ngrok http 3000
```

Copy the HTTPS URL ngrok gives you (e.g. `https://abc123.ngrok-free.app`).

### 6. Register the webhook with Meta

1. Go to your Meta App Dashboard → WhatsApp → Configuration.
2. Set **Callback URL** to `https://abc123.ngrok-free.app/webhook`.
3. Set **Verify Token** to the value you used in `WHATSAPP_VERIFY_TOKEN`.
4. Click **Verify and Save**.
5. Under **Webhook fields**, subscribe to **messages**.

The bot is now live. Send a WhatsApp message to your test number.

---

## Deployment to Vercel

```bash
npm install -g vercel
vercel
```

Add all environment variables from your `.env` file in **Vercel Dashboard → Project → Settings → Environment Variables**.

The `vercel.json` at the project root already handles routing — no additional config needed.

> **Note:** Vercel freezes serverless functions immediately after the response is sent. The server is designed around this: it awaits all processing (Gemini + email) before returning `200` to Meta. Gemini typically responds in 2–5 seconds, well within Meta's 20-second webhook timeout.

---

## Reservation escalation flow

When a guest expresses interest in booking, the agent collects four pieces of information (in any order across the conversation):

1. Full name
2. Arrival date
3. Departure date
4. Number of guests

Once all four are available, Gemini calls the `escalate_to_human` function. The server sends an email to hotel staff containing:

- Guest name
- WhatsApp number
- Arrival and departure dates
- Number of people
- Accommodation type (if mentioned)
- Special requests (if any)

The agent then tells the guest that the team has been notified and will be in touch shortly.

---

## Changing the escalation email

The email address that receives reservation alerts is controlled by the `ESCALATION_EMAIL` environment variable. It is required — the server will refuse to start without it.

**Locally (`.env` file):**
```env
ESCALATION_EMAIL=reservas@ecohotelpure.com
```

**On Vercel:**
Go to **Project → Settings → Environment Variables**, add `ESCALATION_EMAIL` with the target address, then redeploy.

You can also send to multiple addresses by setting up a distribution list or group alias at your email provider and pointing `ESCALATION_EMAIL` at it.

---

## Environment variable reference

| Variable | Required | Description |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Yes | Meta access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes | Meta phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | Yes | Webhook verification secret |
| `WHATSAPP_APP_SECRET` | Yes | Used to verify webhook signatures |
| `GEMINI_API_KEY` | Yes | Google AI Studio API key |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `RESEND_API_KEY` | Yes | Resend API key |
| `ESCALATION_EMAIL` | Yes | Recipient for reservation emails — see [Changing the escalation email](#changing-the-escalation-email) |
| `BOT_ACTIVE` | No | Set to `"false"` to silence the bot (defaults to `true`) |
| `PORT` | No | Server port (defaults to `3000`) |

---

## Project structure

```
wppdemocc/
├── server.js          # Main Express server — all routing, AI, and email logic
├── agent_prompt.md    # Gemini system prompt — hotel info, rules, and agent behavior
├── supabase/
│   └── schema.sql     # Database schema and triggers
├── vercel.json        # Vercel deployment config
└── package.json
```
