import axios from 'axios';

const META_WHATSAPP_TOKEN = process.env.META_WHATSAPP_TOKEN || '';
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '';

// WhatsApp Cloud API hard-rejects any text.body over this length (HTTP 400).
const WHATSAPP_MAX_MESSAGE_LENGTH = 4096;

/**
 * Split a long message into WhatsApp-sized chunks, breaking at the last newline
 * (or space, or a hard cut as a last resort) before the limit so words/paragraphs
 * aren't split mid-way where avoidable.
 */
function chunkMessage(text: string, maxLength: number = WHATSAPP_MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(' ', maxLength);
    if (splitIndex <= 0) splitIndex = maxLength;

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

/**
 * Send a single WhatsApp text message chunk (must already be within the length limit).
 */
async function sendSingleWhatsAppMessage(toPhoneNumber: string, textContent: string): Promise<boolean> {
  try {
    const url = `https://graph.facebook.com/v21.0/${META_PHONE_NUMBER_ID}/messages`;

    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhoneNumber,
        type: 'text',
        text: {
          preview_url: false,
          body: textContent,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${META_WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.status === 200 || response.status === 201;
  } catch (error: any) {
    console.error('❌ Error sending WhatsApp message:', error?.response?.data || error.message);
    return false;
  }
}

/**
 * Send a WhatsApp text message to a specific phone number using Meta Cloud API.
 * Messages over WhatsApp's 4096-character limit are automatically split into
 * multiple sequential messages instead of being rejected outright.
 */
export async function sendWhatsAppMessage(toPhoneNumber: string, textContent: string): Promise<boolean> {
  if (!META_WHATSAPP_TOKEN || !META_PHONE_NUMBER_ID) {
    console.warn('⚠️ Meta WhatsApp credentials not fully configured in environment variables.');
    return false;
  }

  const chunks = chunkMessage(textContent);
  let allSucceeded = true;

  for (const chunk of chunks) {
    const sent = await sendSingleWhatsAppMessage(toPhoneNumber, chunk);
    if (!sent) allSucceeded = false;
  }

  return allSucceeded;
}

/**
 * Send up to 3 quick-reply buttons attached to a short prompt (WhatsApp interactive
 * message). Button titles are capped at 20 characters, WhatsApp's own limit.
 */
export async function sendWhatsAppButtons(
  toPhoneNumber: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>
): Promise<boolean> {
  try {
    if (!META_WHATSAPP_TOKEN || !META_PHONE_NUMBER_ID) {
      console.warn('⚠️ Meta WhatsApp credentials not fully configured in environment variables.');
      return false;
    }

    const url = `https://graph.facebook.com/v21.0/${META_PHONE_NUMBER_ID}/messages`;

    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toPhoneNumber,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.slice(0, 3).map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${META_WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.status === 200 || response.status === 201;
  } catch (error: any) {
    console.error('❌ Error sending WhatsApp button message:', error?.response?.data || error.message);
    return false;
  }
}

/**
 * Mark an inbound message as read and show the "typing..." indicator in the chat
 * while we work on a reply. WhatsApp clears it automatically after ~25s or as soon
 * as the actual reply is sent, whichever comes first.
 */
export async function sendTypingIndicator(inboundMessageId: string): Promise<void> {
  try {
    if (!META_WHATSAPP_TOKEN || !META_PHONE_NUMBER_ID) return;

    const url = `https://graph.facebook.com/v21.0/${META_PHONE_NUMBER_ID}/messages`;

    await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: inboundMessageId,
        typing_indicator: { type: 'text' },
      },
      {
        headers: {
          Authorization: `Bearer ${META_WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error: any) {
    console.error('❌ Error sending typing indicator:', error?.response?.data || error.message);
  }
}

/**
 * Download media content (like audio voice notes) from Meta servers
 */
export async function getWhatsAppMediaBuffer(mediaId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    // 1. Get media URL metadata
    const metaUrl = `https://graph.facebook.com/v21.0/${mediaId}`;
    const metaRes = await axios.get(metaUrl, {
      headers: { Authorization: `Bearer ${META_WHATSAPP_TOKEN}` },
    });

    const downloadUrl = metaRes.data.url;
    const mimeType = metaRes.data.mime_type || 'audio/ogg';

    // 2. Download binary content
    const binaryRes = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${META_WHATSAPP_TOKEN}` },
      responseType: 'arraybuffer',
    });

    return {
      buffer: Buffer.from(binaryRes.data),
      mimeType,
    };
  } catch (error: any) {
    console.error('❌ Error downloading WhatsApp media:', error?.response?.data || error.message);
    return null;
  }
}
