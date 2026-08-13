import { createClient } from '@supabase/supabase-js';
import { UserProfile, ConversationMessage, Memory, Task, Reminder } from '../types';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Default timezone for new users until they tell us (or the assistant infers) otherwise.
const DEFAULT_TIMEZONE = 'Africa/Kigali';

// Fallback dummy client if credentials not yet configured
export const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

/**
 * Get existing user profile or create a new user profile by phone number.
 * `isNewUser` tells the caller whether this account was just created, so it can
 * greet first-time users appropriately.
 */
export async function getOrCreateUser(
  phoneNumber: string,
  name?: string
): Promise<{ profile: UserProfile; isNewUser: boolean } | null> {
  if (!supabase) return null;

  try {
    const { data: existingUser } = await supabase
      .from('users')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();

    if (existingUser) {
      if (name && !existingUser.name) {
        await supabase.from('users').update({ name }).eq('id', existingUser.id);
      }
      return { profile: existingUser as UserProfile, isNewUser: false };
    }

    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({ phone_number: phoneNumber, name, timezone: DEFAULT_TIMEZONE })
      .select()
      .single();

    if (createError) throw createError;
    return { profile: newUser as UserProfile, isNewUser: true };
  } catch (error: any) {
    console.error('❌ Error in getOrCreateUser:', error.message);
    return null;
  }
}

/**
 * Update a user's timezone (IANA name), e.g. after they correct our best-effort guess.
 */
export async function updateUserTimezone(userId: string, timezone: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('users').update({ timezone }).eq('id', userId);
  } catch (error: any) {
    console.error('❌ Error updating user timezone:', error.message);
  }
}

/**
 * All users with an id (used to check each one for a due daily digest).
 */
export async function getAllUsers(): Promise<UserProfile[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase.from('users').select('*');
    if (error) throw error;
    return (data || []) as UserProfile[];
  } catch (error: any) {
    console.error('❌ Error fetching all users:', error.message);
    return [];
  }
}

/**
 * Atomically claim today's digest slot for a user before building/sending it, by
 * conditionally flipping last_digest_date only if it isn't already today's date.
 * Returns true if this call won the claim (safe to send), false if another
 * concurrent run already claimed (or is claiming) today for this user.
 */
export async function claimDigestSlot(userId: string, localDate: string): Promise<boolean> {
  if (!supabase) return true;
  try {
    const { data, error } = await supabase
      .from('users')
      .update({ last_digest_date: localDate })
      .eq('id', userId)
      .or(`last_digest_date.is.null,last_digest_date.neq.${localDate}`)
      .select('id');

    if (error) {
      console.error('❌ Error claiming digest slot:', error.message);
      return false; // fail closed: better to skip today than risk a duplicate send
    }
    return !!(data && data.length > 0);
  } catch (error: any) {
    console.error('❌ Error claiming digest slot:', error.message);
    return false;
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
 * Mark the user's active task(s) whose title matches (case-insensitive substring)
 * as completed. Returns how many tasks were completed.
 */
export async function completeTaskByTitle(userId: string, titleMatch: string): Promise<number> {
  if (!supabase) return 0;
  try {
    const { data, error } = await supabase
      .from('tasks')
      .update({ status: 'completed' })
      .eq('user_id', userId)
      .neq('status', 'completed')
      .ilike('title', `%${titleMatch}%`)
      .select('id');

    if (error) throw error;
    return data ? data.length : 0;
  } catch (error: any) {
    console.error('❌ Error completing task:', error.message);
    return 0;
  }
}

/**
 * Create a scheduled reminder. `recurrence` of 'daily' | 'weekly' | 'monthly' makes
 * it repeat instead of firing once.
 */
export async function createReminder(
  userId: string,
  message: string,
  remindAtISO: string,
  recurrence?: 'daily' | 'weekly' | 'monthly'
): Promise<Reminder | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('reminders')
      .insert({
        user_id: userId,
        message,
        remind_at: remindAtISO,
        status: 'pending',
        recurrence: recurrence || null,
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
 * Fetch the user's active (pending) reminders, soonest first — used to give Gemini
 * context so it can reference/cancel them conversationally.
 */
export async function getUserPendingReminders(userId: string): Promise<Reminder[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('reminders')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('remind_at', { ascending: true });

    if (error) throw error;
    return (data || []) as Reminder[];
  } catch (error: any) {
    console.error('❌ Error fetching pending reminders:', error.message);
    return [];
  }
}

/**
 * Cancel the user's pending reminder(s) matching a case-insensitive substring
 * against either the reminder's message or its recurrence (e.g. "daily" matches
 * a daily reminder even if that word never appears in the message text).
 * Returns how many were cancelled.
 */
export async function cancelReminderByMessage(userId: string, messageMatch: string): Promise<number> {
  if (!supabase) return 0;
  try {
    const { data: candidates, error: fetchError } = await supabase
      .from('reminders')
      .select('id, message, recurrence')
      .eq('user_id', userId)
      .eq('status', 'pending');

    if (fetchError) throw fetchError;

    const needle = messageMatch.toLowerCase();
    const matchingIds = (candidates || [])
      .filter((r) => r.message.toLowerCase().includes(needle) || (r.recurrence && r.recurrence.toLowerCase().includes(needle)))
      .map((r) => r.id);

    if (matchingIds.length === 0) return 0;

    const { error: updateError } = await supabase
      .from('reminders')
      .update({ status: 'cancelled' })
      .in('id', matchingIds);

    if (updateError) throw updateError;
    return matchingIds.length;
  } catch (error: any) {
    console.error('❌ Error cancelling reminder:', error.message);
    return 0;
  }
}

/**
 * Reschedule a recurring reminder to its next occurrence after it's been sent,
 * keeping it pending instead of leaving it sent permanently.
 */
export async function rescheduleRecurringReminder(
  reminderId: string,
  recurrence: 'daily' | 'weekly' | 'monthly',
  previousRemindAtISO: string
): Promise<void> {
  if (!supabase) return;
  try {
    const next = new Date(previousRemindAtISO);
    if (recurrence === 'daily') next.setUTCDate(next.getUTCDate() + 1);
    else if (recurrence === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
    else if (recurrence === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);

    await supabase
      .from('reminders')
      .update({ status: 'pending', remind_at: next.toISOString() })
      .eq('id', reminderId);
  } catch (error: any) {
    console.error('❌ Error rescheduling recurring reminder:', error.message);
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
 * Atomically claim a reminder before sending it, by conditionally flipping it
 * pending -> sent only if it's still pending. Returns true if this call won the
 * claim (safe to send), false if another concurrent run already claimed it
 * (e.g. overlapping cron triggers during a slow cold start).
 */
export async function claimReminder(reminderId: string): Promise<boolean> {
  if (!supabase) return true;
  try {
    const { data, error } = await supabase
      .from('reminders')
      .update({ status: 'sent' })
      .eq('id', reminderId)
      .eq('status', 'pending')
      .select('id');

    if (error) {
      console.error('❌ Error claiming reminder:', error.message);
      return false; // fail closed: better to retry next tick than risk a duplicate send
    }
    return !!(data && data.length > 0);
  } catch (error: any) {
    console.error('❌ Error claiming reminder:', error.message);
    return false;
  }
}

/**
 * Revert a claimed reminder back to pending if the send itself failed,
 * so it gets retried on the next scheduler tick instead of being lost.
 */
export async function revertReminderToPending(reminderId: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('reminders').update({ status: 'pending' }).eq('id', reminderId);
  } catch (error: any) {
    console.error('❌ Error reverting reminder status:', error.message);
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
