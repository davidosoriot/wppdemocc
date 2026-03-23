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
 *      GEMINI_API_KEY             — API key from Google AI Studio
 *      SUPABASE_URL               — Project URL from Supabase dashboard
 *      SUPABASE_SERVICE_ROLE_KEY  — Service role key (NOT the anon key)
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
const fs      = require('fs');
const path    = require('path');
const { createClient }       = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─── Environment ─────────────────────────────────────────────────────────────

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  GEMINI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT = 3000,
} = process.env;

const MISSING = [
  ['WHATSAPP_ACCESS_TOKEN',     WHATSAPP_ACCESS_TOKEN],
  ['WHATSAPP_PHONE_NUMBER_ID',  WHATSAPP_PHONE_NUMBER_ID],
  ['WHATSAPP_VERIFY_TOKEN',     WHATSAPP_VERIFY_TOKEN],
  ['GEMINI_API_KEY',            GEMINI_API_KEY],
  ['SUPABASE_URL',              SUPABASE_URL],
  ['SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY],
].filter(([, v]) => !v).map(([k]) => k);

if (MISSING.length) {
  console.error('[startup] Missing environment variables:', MISSING.join(', '));
  process.exit(1);
}

// ─── Clients ─────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const genAI    = new GoogleGenerativeAI(GEMINI_API_KEY);

// ─── Agent system prompt ─────────────────────────────────────────────────────

const AGENT_PROMPT = fs.readFileSync(
  path.join(__dirname, 'agent_prompt.md'),
  'utf8'
);

// System instruction must be set at model level, not at startChat level
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  systemInstruction: AGENT_PROMPT,
});

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

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
  console.log('[webhook] Payload received');

  try {
    const entry   = req.body?.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const message = value?.messages?.[0];

    // Ignore status updates
    if (value?.statuses) {
      console.log('[webhook] Status update — skipping');
      return res.sendStatus(200);
    }

    // Ignore everything that isn't an inbound text message
    if (!message || message.type !== 'text') {
      console.log('[webhook] Non-text message or empty payload — skipping');
      return res.sendStatus(200);
    }

    const phoneNumber = message.from;
    const messageText = message.text.body;

    console.log(`[message] From: ${phoneNumber} | Text: "${messageText}"`);

    // ── 1. Resolve or create conversation ──────────────────────────────────
    const conversationId = await getOrCreateConversation(phoneNumber);

    // ── 2. Persist the user message ────────────────────────────────────────
    await saveMessage(conversationId, 'user', messageText);

    // ── 3. Build conversation history for context ──────────────────────────
    const history = await getRecentMessages(conversationId, 10);

    // ── 4. Call Gemini ─────────────────────────────────────────────────────
    const aiResponse = await callGemini(history, messageText);

    console.log(`[gemini] Response: "${aiResponse}"`);

    // ── 5. Persist the assistant message ──────────────────────────────────
    await saveMessage(conversationId, 'assistant', aiResponse);

    // ── 6. Send reply via WhatsApp Cloud API ───────────────────────────────
    await sendWhatsAppMessage(phoneNumber, aiResponse);

    // Acknowledge after all processing is complete (critical for Vercel serverless)
    res.sendStatus(200);

  } catch (err) {
    console.error('[webhook] Unhandled error:', err.message || err);
    res.sendStatus(500);
  }
});

// ─── Supabase helpers ─────────────────────────────────────────────────────────

/**
 * Returns the conversation id for a phone number.
 * Creates a new conversation row if one doesn't exist yet.
 */
async function getOrCreateConversation(phoneNumber) {
  // Try to find existing conversation
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

  // Create new conversation
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

/**
 * Inserts a message row into the messages table.
 */
async function saveMessage(conversationId, role, content) {
  const { error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role, content });

  if (error) {
    console.error('[supabase] Error saving message:', error.message);
    throw error;
  }
}

/**
 * Returns the last `limit` messages for a conversation, oldest first,
 * so they can be fed to the model in chronological order.
 */
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

  // Reverse so oldest message comes first
  return (data || []).reverse();
}

// ─── Gemini helper ────────────────────────────────────────────────────────────

/**
 * Sends the conversation history and the latest user message to Gemini.
 * Returns the model's plain-text response.
 *
 * @param {Array<{role: string, content: string}>} history  Previous messages
 * @param {string} userMessage  The new message from the user
 */
async function callGemini(history, userMessage) {
  // Build the chat history in the format Gemini expects
  // Skip the very last message if it's the current user turn (already in userMessage)
  const chatHistory = history
    .slice(0, -1) // exclude the message we just saved (current user turn)
    .map(({ role, content }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content }],
    }));

  const chat = model.startChat({
    history: chatHistory,
  });

  const result = await chat.sendMessage(userMessage);
  return result.response.text();
}

// ─── WhatsApp Cloud API helper ────────────────────────────────────────────────

/**
 * Sends a text message to a WhatsApp number via the Cloud API.
 */
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

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
// In local development, start the HTTP server.
// On Vercel (serverless), the app is exported and Vercel handles the binding.

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[startup] Server running on port ${PORT}`);
    console.log(`[startup] Webhook URL: http://localhost:${PORT}/webhook`);
    console.log('[startup] Expose with ngrok: ngrok http ' + PORT);
  });
}

module.exports = app;
