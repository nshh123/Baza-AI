import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { WhatsAppWebhookPayload } from '../types';
import { getOrCreateUser, claimMessageId, getUserTasks, getUserPendingReminders } from '../services/supabase';
import { processUserMessage } from '../services/gemini';
import { sendWhatsAppMessage, sendWhatsAppButtons, sendTypingIndicator, getWhatsAppMediaBuffer } from '../services/whatsapp';
import { formatTaskList, formatReminderList } from '../utils/formatting';

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'my_secret_whatsapp_verify_token_123';
const META_APP_SECRET = process.env.META_APP_SECRET || '';

const WELCOME_MESSAGE = `👋 Hi, I'm *Baza AI* — your personal AI assistant, accessible anytime right here on WhatsApp!

I can remember things for you, manage your tasks and reminders, answer questions, and more — just message me anytime, day or night. What can I help you with today?`;

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

    // Skip duplicate deliveries (Meta retries webhooks it couldn't confirm were received)
    const isNewMessage = await claimMessageId(message.id);
    if (!isNewMessage) {
      console.log(`⏭️ Skipping duplicate webhook delivery for message ${message.id}`);
      return;
    }

    // Show the typing indicator right away, in parallel with the (potentially slow)
    // processing below, so the wait feels natural instead of silent. WhatsApp clears
    // it after 25s on its own, but Gemini congestion can push replies well past that
    // — so refresh it every 20s (safely under the cap) for as long as we're still
    // working, instead of letting it lapse into a silent gap before the reply.
    let typingIntervalId: NodeJS.Timeout | undefined;
    if (message.type === 'text' || message.type === 'audio' || message.type === 'image') {
      sendTypingIndicator(message.id);
      typingIntervalId = setInterval(() => sendTypingIndicator(message.id), 20000);
    }

    // 1. Fetch or register user in database
    const userResult = await getOrCreateUser(senderPhone, contactName);
    const user = userResult?.profile || {
      id: '',
      phone_number: senderPhone,
      name: contactName,
      timezone: 'Africa/Kigali',
      created_at: new Date().toISOString(),
    };

    // Greet brand-new users before handling whatever they actually sent
    if (userResult?.isNewUser) {
      await sendWhatsAppMessage(senderPhone, WELCOME_MESSAGE);
    }

    let replyText = '';
    let replyButtons: Array<{ id: string; title: string }> | undefined;

    try {
      // 2. Process quick-reply button taps (handled deterministically, no Gemini call needed)
      if (message.type === 'interactive' && message.interactive?.button_reply) {
        const buttonId = message.interactive.button_reply.id;
        const timezone = user.timezone || 'UTC';

        if (buttonId === 'view_tasks' && user.id) {
          const tasks = await getUserTasks(user.id);
          replyText = `📋 *Your Current Daily Plan:*\n${formatTaskList(tasks, timezone)}`;
        } else if (buttonId === 'view_reminders' && user.id) {
          const reminders = await getUserPendingReminders(user.id);
          replyText = `⏰ *Your Active Reminders:*\n${formatReminderList(reminders, timezone)}`;
        }
      }
      // 3. Process Text Messages
      else if (message.type === 'text' && message.text) {
        const textContent = message.text.body;
        const result = await processUserMessage(user, textContent);
        replyText = result.text;
        replyButtons = result.buttons;
      }
      // 4. Process Voice Note Audio Messages
      else if (message.type === 'audio' && message.audio) {
        console.log(`🎙️ Downloading voice note media (ID: ${message.audio.id})...`);
        const mediaData = await getWhatsAppMediaBuffer(message.audio.id);

        if (mediaData) {
          const result = await processUserMessage(user, undefined, mediaData.buffer, mediaData.mimeType);
          replyText = result.text;
          replyButtons = result.buttons;
        } else {
          replyText = '⚠️ Sorry, I could not process your voice note. Please try sending it again or type your message!';
        }
      }
      // 5. Process Image Messages
      else if (message.type === 'image' && message.image) {
        console.log(`🖼️ Downloading image media (ID: ${message.image.id})...`);
        const mediaData = await getWhatsAppMediaBuffer(message.image.id);

        if (mediaData) {
          const result = await processUserMessage(user, message.image.caption, mediaData.buffer, mediaData.mimeType);
          replyText = result.text;
          replyButtons = result.buttons;
        } else {
          replyText = '⚠️ Sorry, I could not process your image. Please try sending it again or describe what you need in text!';
        }
      } else {
        replyText = `I received your ${message.type} message! Currently I work best with text messages, voice notes, and images. Feel free to ask me anything!`;
      }
    } finally {
      if (typingIntervalId) clearInterval(typingIntervalId);
    }

    // 6. Send response back to sender on WhatsApp
    if (replyText) {
      await sendWhatsAppMessage(senderPhone, replyText);
    }
    if (replyButtons && replyButtons.length > 0) {
      await sendWhatsAppButtons(senderPhone, 'Quick actions:', replyButtons);
    }
  } catch (error: any) {
    console.error('❌ Error handling WhatsApp webhook event:', error.message);
  }
}
