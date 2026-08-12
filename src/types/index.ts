export interface UserProfile {
  id: string;
  phone_number: string;
  name?: string;
  timezone: string;
  created_at: string;
}

export interface ConversationMessage {
  id?: string;
  user_id: string;
  role: 'user' | 'model' | 'system';
  content: string;
  created_at?: string;
}

export interface Memory {
  id?: string;
  user_id: string;
  category: string;
  content: string;
  created_at?: string;
}

export interface Task {
  id?: string;
  user_id: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed';
  due_date?: string;
  created_at?: string;
}

export interface Reminder {
  id?: string;
  user_id: string;
  message: string;
  remind_at: string;
  status: 'pending' | 'sent' | 'cancelled';
  recurrence?: 'daily' | 'weekly' | 'monthly' | null;
  created_at?: string;
  users?: {
    phone_number: string;
    name?: string;
  };
}

// WhatsApp Webhook Interfaces
export interface WhatsAppMessage {
  from: string; // Sender's phone number e.g. "15551234567"
  id: string;
  timestamp: string;
  type: 'text' | 'audio' | 'image' | 'document' | 'interactive' | 'unknown';
  text?: {
    body: string;
  };
  audio?: {
    id: string;
    mime_type: string;
  };
  image?: {
    id: string;
    mime_type: string;
    caption?: string;
  };
  interactive?: {
    type: string;
    button_reply?: {
      id: string;
      title: string;
    };
  };
}

export interface WhatsAppWebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      value: {
        messaging_product: string;
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: {
            name: string;
          };
          wa_id: string;
        }>;
        messages?: WhatsAppMessage[];
      };
      field: string;
    }>;
  }>;
}
