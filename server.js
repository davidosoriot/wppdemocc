/**
 * WhatsApp AI Agent — server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP INSTRUCTIONS
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Install dependencies:
 *      npm install
 *
 * 2. Copy the env template and fill in your credentials:
 *      cp .env.example .env
 *
 *    Required values:
 *      WHATSAPP_ACCESS_TOKEN      — Permanent or temporary token from Meta
 *      WHATSAPP_PHONE_NUMBER_ID   — Phone Number ID from Meta App Dashboard
 *      WHATSAPP_VERIFY_TOKEN      — Any secret string you choose (used once
 *                                   to verify the webhook with Meta)
 *      WHATSAPP_APP_SECRET        — App Secret (Meta App Dashboard → Basic Settings)
 *      GEMINI_API_KEY             — API key from Google AI Studio
 *      SUPABASE_URL               — Project URL from Supabase dashboard
 *      SUPABASE_SERVICE_ROLE_KEY  — Service role key (NOT the anon key)
 *      BOT_ACTIVE                 — Set to "false" to disable the bot without
 *                                   taking down the server (safe offboarding)
 *
 * 3. Run the database migrations:
 *      Paste supabase/schema.sql into the Supabase SQL Editor and execute it.
 *
 * 4. Start the server:
 *      npm start          (production)
 *      npm run dev        (auto-restart on file changes, Node 18+)
 *
 * 5. Expose your local server to the internet with ngrok:
 *      ngrok http 3000
 *
 *    Copy the HTTPS URL ngrok gives you, e.g.:
 *      https://abc123.ngrok-free.app
 *
 * 6. Register the webhook in Meta App Dashboard:
 *      Callback URL : https://abc123.ngrok-free.app/webhook
 *      Verify Token : the value you set in WHATSAPP_VERIFY_TOKEN
 *      Subscribe to : messages
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { createClient }       = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Resend }             = require('resend');

// ─── Environment ─────────────────────────────────────────────────────────────

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_APP_SECRET,
  GEMINI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  RESEND_API_KEY,
  ESCALATION_EMAIL,
  PORT = 3000,
} = process.env;

// BOT_ACTIVE defaults to true — set to "false" in env to silently disable the bot
const BOT_ACTIVE = process.env.BOT_ACTIVE !== 'false';

const MISSING = [
  ['WHATSAPP_ACCESS_TOKEN',     WHATSAPP_ACCESS_TOKEN],
  ['WHATSAPP_PHONE_NUMBER_ID',  WHATSAPP_PHONE_NUMBER_ID],
  ['WHATSAPP_VERIFY_TOKEN',     WHATSAPP_VERIFY_TOKEN],
  ['WHATSAPP_APP_SECRET',       WHATSAPP_APP_SECRET],
  ['GEMINI_API_KEY',            GEMINI_API_KEY],
  ['SUPABASE_URL',              SUPABASE_URL],
  ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY],
  ['RESEND_API_KEY',            RESEND_API_KEY],
  ['ESCALATION_EMAIL',          ESCALATION_EMAIL],
].filter(([, v]) => !v).map(([k]) => k);

if (MISSING.length) {
  console.error('[startup] Missing environment variables:', MISSING.join(', '));
  process.exit(1);
}

// ─── Clients ─────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const genAI    = new GoogleGenerativeAI(GEMINI_API_KEY);
const resend   = new Resend(RESEND_API_KEY);

// ─── Agent system prompt ─────────────────────────────────────────────────────

const AGENT_PROMPT = fs.readFileSync(
  path.join(__dirname, 'agent_prompt.md'),
  'utf8'
);

const ESCALATE_TOOL = {
  functionDeclarations: [{
    name: 'escalate_to_human',
    description: 'Notifica al equipo del hotel sobre una solicitud de reserva. Llama esta función solo cuando el cliente haya proporcionado su nombre, fechas de llegada y salida, y número de personas.',
    parameters: {
      type: 'OBJECT',
      properties: {
        guest_name:       { type: 'STRING',  description: 'Nombre completo del huésped' },
        arrival_date:     { type: 'STRING',  description: 'Fecha de llegada (dd/mm/aaaa)' },
        departure_date:   { type: 'STRING',  description: 'Fecha de salida (dd/mm/aaaa)' },
        num_people:       { type: 'INTEGER', description: 'Número de personas' },
        accommodation:    { type: 'STRING',  description: 'Tipo de alojamiento solicitado (si lo mencionó)' },
        special_requests: { type: 'STRING',  description: 'Solicitudes especiales o notas adicionales' },
      },
      required: ['guest_name', 'arrival_date', 'departure_date', 'num_people'],
    },
  }],
};

const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  systemInstruction: AGENT_PROMPT,
  tools: [ESCALATE_TOOL],
});

// Rate limiting: phoneNumber → { count, resetAt } (in-memory, per instance)
const rateLimits = new Map();

// ─── Express app ─────────────────────────────────────────────────────────────

// Capture raw body buffer before JSON parsing — required for Meta signature validation
const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ─── Security helpers ─────────────────────────────────────────────────────────

/**
 * Validates the x-hub-signature-256 header sent by Meta on every POST.
 * Rejects requests that don't come from Meta or have been tampered with.
 */
function verifyMetaSignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', WHATSAPP_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');
  // timingSafeEqual prevents timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

/**
 * Atomically marks a message ID as processed in Supabase.
 * Returns true if it was already processed (duplicate).
 * Using DB instead of in-memory Map so it works across Vercel serverless instances.
 */
async function isDuplicate(messageId) {
  const { error } = await supabase
    .from('processed_messages')
    .insert({ message_id: messageId });

  if (error?.code === '23505') return true; // unique constraint → already processed
  if (error) throw error;
  return false;
}

/**
 * Returns true if the phone number has exceeded 10 messages per minute.
 * Silently drops excess traffic without responding — responding with an error
 * would itself generate more retries.
 */
function isRateLimited(phoneNumber) {
  const now = Date.now();
  const entry = rateLimits.get(phoneNumber) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  rateLimits.set(phoneNumber, entry);
  if (entry.count > 10) {
    console.warn(`[rate-limit] ${phoneNumber} exceeded 10 msg/min — skipping`);
    return true;
  }
  return false;
}

// ─── GET /webhook — Meta verification handshake ───────────────────────────────

app.get('/webhook', (req, res) => {
  console.log('[webhook] Verification request received');

  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('[webhook] Verification successful');
    return res.status(200).send(challenge);
  }

  console.warn('[webhook] Verification failed — token mismatch');
  return res.sendStatus(403);
});

// ─── POST /webhook — Incoming WhatsApp messages ───────────────────────────────

app.post('/webhook', async (req, res) => {
  // Reject requests that don't carry a valid Meta signature
  if (!verifyMetaSignature(req)) {
    console.warn('[webhook] Invalid or missing signature — rejected');
    return res.sendStatus(403);
  }

  // On Vercel serverless, the function is frozen after res is sent.
  // We must await all processing first, then respond 200.
  // Gemini typically responds in 2-5s — well within Meta's 20s timeout.
  try {
    await processIncomingMessage(req.body);
  } catch (err) {
    console.error('[webhook] Unhandled processing error:', err.message);
  }

  // Always 200 to Meta regardless of outcome — never 5xx
  res.sendStatus(200);
});

// ─── Core message processing ──────────────────────────────────────────────────

async function processIncomingMessage(body) {
  // Bot kill-switch: change BOT_ACTIVE=false in Vercel env for safe client offboarding.
  // Meta still receives 200, the WhatsApp number keeps working, the bot just goes silent.
  if (!BOT_ACTIVE) {
    console.log('[bot] Inactive — message received but not processed');
    return;
  }

  const entry   = body?.entry?.[0];
  const change  = entry?.changes?.[0];
  const value   = change?.value;

  // Ignore delivery/read status updates — only process inbound messages
  if (!value?.messages || value?.statuses) {
    console.log('[webhook] Status update or empty payload — skipping');
    return;
  }

  const message = value.messages[0];

  // Only handle plain text messages
  if (!message || message.type !== 'text') {
    console.log('[webhook] Non-text message — skipping');
    return;
  }

  const phoneNumber = message.from;
  const messageText = message.text.body;
  const messageId   = message.id;

  // Deduplicate via Supabase — works across all Vercel serverless instances
  if (await isDuplicate(messageId)) {
    console.log(`[dedup] Message ${messageId} already processed — skipping`);
    return;
  }

  // Rate limit: silently drop if user is sending too fast
  if (isRateLimited(phoneNumber)) return;

  console.log(`[message] From: ${phoneNumber} | Text: "${messageText}"`);

  // ── 1. Resolve or create conversation ────────────────────────────────────
  const conversationId = await getOrCreateConversation(phoneNumber);

  // ── 2. Persist the user message ──────────────────────────────────────────
  await saveMessage(conversationId, 'user', messageText);

  // ── 3. Build conversation history for context ─────────────────────────────
  const history = await getRecentMessages(conversationId, 10);

  // ── 4. Call Gemini — fallback to friendly message on any error ────────────
  let aiResponse;
  try {
    aiResponse = await callGemini(history, messageText, phoneNumber);
    console.log('[gemini] Response generated');
  } catch (err) {
    console.error('[gemini] Error:', err.message);
    aiResponse = 'En este momento tengo un inconveniente técnico. Por favor escríbenos de nuevo en unos minutos o contáctanos directamente. 🙏';
  }

  // ── 5. Enforce WhatsApp's 4096-char message limit ─────────────────────────
  const WA_MAX = 4000;
  if (aiResponse.length > WA_MAX) {
    aiResponse = aiResponse.substring(0, WA_MAX) + '\n\n_(Para más información, contáctanos directamente.)_';
    console.warn('[whatsapp] Response truncated to 4000 chars');
  }

  // ── 6. Persist the assistant response ────────────────────────────────────
  await saveMessage(conversationId, 'assistant', aiResponse);

  // ── 7. Send reply via WhatsApp Cloud API ──────────────────────────────────
  await sendWhatsAppMessage(phoneNumber, aiResponse);
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function getOrCreateConversation(phoneNumber) {
  const { data: existing, error: selectError } = await supabase
    .from('conversations')
    .select('id')
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (selectError) {
    console.error('[supabase] Error fetching conversation:', selectError.message);
    throw selectError;
  }

  if (existing) return existing.id;

  const { data: created, error: insertError } = await supabase
    .from('conversations')
    .insert({ phone_number: phoneNumber })
    .select('id')
    .single();

  if (insertError) {
    console.error('[supabase] Error creating conversation:', insertError.message);
    throw insertError;
  }

  console.log(`[supabase] New conversation created for ${phoneNumber}`);
  return created.id;
}

async function saveMessage(conversationId, role, content) {
  const { error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role, content });

  if (error) {
    console.error('[supabase] Error saving message:', error.message);
    throw error;
  }
}

async function getRecentMessages(conversationId, limit = 10) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[supabase] Error fetching history:', error.message);
    throw error;
  }

  return (data || []).reverse();
}

// ─── Gemini helper ────────────────────────────────────────────────────────────

async function callGemini(history, userMessage, phoneNumber) {
  const chatHistory = history
    .slice(0, -1)
    .map(({ role, content }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content }],
    }));

  // Gemini requires the first message in history to be from 'user'.
  // If the history window starts with a 'model' message, drop entries
  // from the front until we reach a 'user' message.
  while (chatHistory.length > 0 && chatHistory[0].role !== 'user') {
    chatHistory.shift();
  }

  const chat   = model.startChat({ history: chatHistory });
  const result = await chat.sendMessage(userMessage);
  const calls  = result.response.functionCalls();

  if (calls && calls.length > 0) {
    const call = calls[0];
    console.log(`[gemini] Function call: ${call.name}`, call.args);

    let toolResult;
    if (call.name === 'escalate_to_human') {
      toolResult = await handleEscalation(call.args, phoneNumber);
    } else {
      toolResult = { error: 'Unknown function' };
    }

    // Feed the function result back so Gemini generates the final user-facing reply
    const followUp = await chat.sendMessage([{
      functionResponse: { name: call.name, response: toolResult },
    }]);
    return followUp.response.text();
  }

  return result.response.text();
}

// ─── Escalation handler ───────────────────────────────────────────────────────

async function handleEscalation(args, phoneNumber) {
  try {
    await sendEscalationEmail(args, phoneNumber);
    console.log('[escalation] Email sent for guest:', args.guest_name);
    return { success: true };
  } catch (err) {
    console.error('[escalation] Failed to send email:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendEscalationEmail({ guest_name, arrival_date, departure_date, num_people, accommodation, special_requests }, phoneNumber) {
  const accom   = accommodation    || 'No especificado';
  const notes   = special_requests || 'Ninguna';

  const html = `
    <h2>Nueva solicitud de reserva — Ecohotel Pure</h2>
    <table cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:15px;">
      <tr><td><strong>Nombre</strong></td><td>${guest_name}</td></tr>
      <tr><td><strong>WhatsApp</strong></td><td>+${phoneNumber}</td></tr>
      <tr><td><strong>Llegada</strong></td><td>${arrival_date}</td></tr>
      <tr><td><strong>Salida</strong></td><td>${departure_date}</td></tr>
      <tr><td><strong>Personas</strong></td><td>${num_people}</td></tr>
      <tr><td><strong>Alojamiento</strong></td><td>${accom}</td></tr>
      <tr><td><strong>Solicitudes especiales</strong></td><td>${notes}</td></tr>
    </table>
    <p style="margin-top:16px;color:#555;">Este mensaje fue generado automáticamente por el asistente de WhatsApp de Ecohotel Pure.</p>
  `;

  const { error } = await resend.emails.send({
    from:    'Ecohotel Pure <onboarding@resend.dev>',
    to:      ESCALATION_EMAIL,
    subject: `Reserva: ${guest_name} · ${arrival_date} → ${departure_date}`,
    html,
  });

  if (error) throw new Error(error.message);
}

// ─── WhatsApp Cloud API helper ────────────────────────────────────────────────

async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`[whatsapp] Message sent to ${to}`);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[whatsapp] Error sending message:', JSON.stringify(detail));
    throw err;
  }
}

// ─── Start server ─────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[startup] Server running on port ${PORT}`);
    console.log(`[startup] Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`[startup] Bot active: ${BOT_ACTIVE}`);
    console.log('[startup] Expose with ngrok: ngrok http ' + PORT);
  });
}

module.exports = app;
