import axios from 'axios';

const META_WHATSAPP_TOKEN = process.env.META_WHATSAPP_TOKEN || '';
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '';

/**
 * Send a WhatsApp text message to a specific phone number using Meta Cloud API
 */
export async function sendWhatsAppMessage(toPhoneNumber: string, textContent: string): Promise<boolean> {
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
