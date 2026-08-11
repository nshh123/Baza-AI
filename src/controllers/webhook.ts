import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { WhatsAppWebhookPayload } from '../types';
import { getOrCreateUser } from '../services/supabase';
import { processUserMessage } from '../services/gemini';
import { sendWhatsAppMessage, getWhatsAppMediaBuffer } from '../services/whatsapp';

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'my_secret_whatsapp_verify_token_123';
const META_APP_SECRET = process.env.META_APP_SECRET || '';

/**
 * Verify that incoming webhook POSTs are genuinely signed by Meta.
 * Compares the X-Hub-Signature-256 header against an HMAC-SHA256 of the raw request body,
 * keyed with the app secret (developers.facebook.com > App Settings > Basic > App Secret).
 */
export function verifyWebhookSignature(req: Request, res: Response, next: NextFunction): void {
  if (!META_APP_SECRET) {
    console.warn('⚠️ META_APP_SECRET is not set — webhook signature verification is DISABLED. Anyone can post fake events to /webhook.');
    next();
    return;
  }

  const signatureHeader = req.header('x-hub-signature-256');
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!signatureHeader || !rawBody) {
    console.warn('⚠️ Rejected webhook POST: missing signature header or raw body.');
    res.sendStatus(401);
    return;
  }

  const expectedSignature = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(rawBody).digest('hex');
  const actual = Buffer.from(signatureHeader);
  const expected = Buffer.from(expectedSignature);

  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    console.warn('⚠️ Rejected webhook POST: signature mismatch.');
    res.sendStatus(401);
    return;
  }

  next();
}

/**
 * Verification Endpoint for Meta Developer Portal (GET)
 */
export function verifyWebhook(req: Request, res: Response): void {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
      console.log('✅ Webhook verified successfully by Meta!');
      res.status(200).send(challenge);
      return;
    } else {
      console.warn('⚠️ Webhook verification failed. Token mismatch.');
      res.sendStatus(403);
      return;
    }
  }

  res.sendStatus(400);
}

/**
 * Handle incoming WhatsApp Messages & Events (POST)
 */
export async function handleWebhookEvent(req: Request, res: Response): Promise<void> {
  // Always return HTTP 200 immediately to Meta so webhooks don't timeout or retry
  res.status(200).send('EVENT_RECEIVED');

  try {
    console.log('📥 Webhook POST Payload:', JSON.stringify(req.body, null, 2));
    const payload: WhatsAppWebhookPayload = req.body;

    if (payload.object !== 'whatsapp_business_account') return;

    const entry = payload.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value || !value.messages || value.messages.length === 0) return;

    const message = value.messages[0];
    const senderPhone = message.from;
    const contactName = value.contacts?.[0]?.profile?.name || 'Friend';

    console.log(`📩 Incoming message from ${contactName} (${senderPhone}) [Type: ${message.type}]`);

    // 1. Fetch or register user in database
    const userProfile = await getOrCreateUser(senderPhone, contactName);
    const user = userProfile || {
      id: '',
      phone_number: senderPhone,
      name: contactName,
      timezone: 'UTC',
      created_at: new Date().toISOString(),
    };

    let replyText = '';

    // 2. Process Text Messages
    if (message.type === 'text' && message.text) {
      const textContent = message.text.body;
      replyText = await processUserMessage(user, textContent);
    }
    // 3. Process Voice Note Audio Messages
    else if (message.type === 'audio' && message.audio) {
      console.log(`🎙️ Downloading voice note media (ID: ${message.audio.id})...`);
      const mediaData = await getWhatsAppMediaBuffer(message.audio.id);

      if (mediaData) {
        replyText = await processUserMessage(user, undefined, mediaData.buffer, mediaData.mimeType);
      } else {
        replyText = '⚠️ Sorry, I could not process your voice note. Please try sending it again or type your message!';
      }
    } else {
      replyText = `I received your ${message.type} message! Currently I work best with text messages and voice notes. Feel free to ask me anything!`;
    }

    // 4. Send response back to sender on WhatsApp
    if (replyText) {
      await sendWhatsAppMessage(senderPhone, replyText);
    }
  } catch (error: any) {
    console.error('❌ Error handling WhatsApp webhook event:', error.message);
  }
}
