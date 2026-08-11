import { createClient } from '@supabase/supabase-js';
import { UserProfile, ConversationMessage, Memory, Task, Reminder } from '../types';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Fallback dummy client if credentials not yet configured
export const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

/**
 * Get existing user profile or create a new user profile by phone number
 */
export async function getOrCreateUser(phoneNumber: string, name?: string): Promise<UserProfile | null> {
  if (!supabase) return null;

  try {
    const { data: existingUser, error: findError } = await supabase
      .from('users')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();

    if (existingUser) {
      if (name && !existingUser.name) {
        await supabase.from('users').update({ name }).eq('id', existingUser.id);
      }
      return existingUser as UserProfile;
    }

    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({ phone_number: phoneNumber, name })
      .select()
      .single();

    if (createError) throw createError;
    return newUser as UserProfile;
  } catch (error: any) {
    console.error('❌ Error in getOrCreateUser:', error.message);
    return null;
  }
}

/**
 * Save conversation message for user context memory
 */
export async function saveConversationMessage(userId: string, role: 'user' | 'model', content: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('conversations').insert({
      user_id: userId,
      role,
      content,
    });
  } catch (error: any) {
    console.error('❌ Error saving conversation message:', error.message);
  }
}

/**
 * Get recent conversation history for a user
 */
export async function getRecentConversations(userId: string, limit: number = 10): Promise<ConversationMessage[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).reverse() as ConversationMessage[];
  } catch (error: any) {
    console.error('❌ Error fetching recent conversations:', error.message);
    return [];
  }
}

/**
 * Store a persistent user memory / fact
 */
export async function storeUserMemory(userId: string, content: string, category: string = 'general'): Promise<Memory | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('memories')
      .insert({ user_id: userId, category, content })
      .select()
      .single();

    if (error) throw error;
    return data as Memory;
  } catch (error: any) {
    console.error('❌ Error storing memory:', error.message);
    return null;
  }
}

/**
 * Get all stored memories for a user
 */
export async function getUserMemories(userId: string): Promise<Memory[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data || []) as Memory[];
  } catch (error: any) {
    console.error('❌ Error fetching user memories:', error.message);
    return [];
  }
}

/**
 * Create a new task / daily plan item
 */
export async function createTask(userId: string, title: string, description?: string, dueDate?: string): Promise<Task | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('tasks')
      .insert({
        user_id: userId,
        title,
        description,
        due_date: dueDate || null,
      })
      .select()
      .single();

    if (error) throw error;
    return data as Task;
  } catch (error: any) {
    console.error('❌ Error creating task:', error.message);
    return null;
  }
}

/**
 * Get tasks for a user
 */
export async function getUserTasks(userId: string): Promise<Task[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .eq('user_id', userId)
      .neq('status', 'completed')
      .order('created_at', { ascending: true });

    if (error) throw error;
    return (data || []) as Task[];
  } catch (error: any) {
    console.error('❌ Error fetching tasks:', error.message);
    return [];
  }
}

/**
 * Create a scheduled reminder
 */
export async function createReminder(userId: string, message: string, remindAtISO: string): Promise<Reminder | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('reminders')
      .insert({
        user_id: userId,
        message,
        remind_at: remindAtISO,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;
    return data as Reminder;
  } catch (error: any) {
    console.error('❌ Error creating reminder:', error.message);
    return null;
  }
}

/**
 * Fetch pending reminders due now or earlier
 */
export async function getDueReminders(): Promise<Reminder[]> {
  if (!supabase) return [];
  try {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('reminders')
      .select('*, users(phone_number, name)')
      .eq('status', 'pending')
      .lte('remind_at', now);

    if (error) throw error;
    return (data || []) as Reminder[];
  } catch (error: any) {
    console.error('❌ Error fetching due reminders:', error.message);
    return [];
  }
}

/**
 * Mark reminder as sent
 */
export async function markReminderSent(reminderId: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from('reminders')
      .update({ status: 'sent' })
      .eq('id', reminderId);
  } catch (error: any) {
    console.error('❌ Error updating reminder status:', error.message);
  }
}

/**
 * Atomically claim a WhatsApp message ID before processing it.
 * Returns true the first time a given ID is seen (safe to process), false if
 * it's a duplicate delivery (e.g. Meta retried the webhook) that should be skipped.
 */
export async function claimMessageId(messageId: string): Promise<boolean> {
  if (!supabase) return true;
  try {
    const { error } = await supabase.from('processed_messages').insert({ message_id: messageId });
    if (!error) return true;
    if (error.code === '23505') return false; // unique_violation -> already processed
    console.error('❌ Error claiming message id:', error.message);
    return true; // fail open: don't drop a legitimate message over an unrelated DB error
  } catch (error: any) {
    console.error('❌ Error claiming message id:', error.message);
    return true;
  }
}
