import cron from 'node-cron';
import { getDueReminders, markReminderSent } from './supabase';
import { sendWhatsAppMessage } from './whatsapp';

/**
 * Check for due reminders and dispatch them over WhatsApp.
 * Called both by the internal cron tick and by the external /cron/check-reminders
 * endpoint, since a free-tier host may be asleep when the internal tick would fire.
 */
export async function checkAndDispatchReminders(): Promise<number> {
  try {
    const dueReminders = await getDueReminders();

    if (dueReminders.length === 0) return 0;

    console.log(`⏰ Found ${dueReminders.length} due reminder(s). Dispatching...`);

    for (const reminder of dueReminders) {
      const recipientPhone = reminder.users?.phone_number;
      if (!recipientPhone) continue;

      const reminderText = `⏰ *REMINDER!*\n\n${reminder.message}`;
      const sentSuccess = await sendWhatsAppMessage(recipientPhone, reminderText);

      if (sentSuccess) {
        await markReminderSent(reminder.id!);
        console.log(`✅ Sent reminder "${reminder.message}" to ${recipientPhone}`);
      } else {
        console.error(`❌ Failed to send reminder "${reminder.message}" to ${recipientPhone}`);
      }
    }

    return dueReminders.length;
  } catch (error: any) {
    console.error('❌ Error checking due reminders:', error.message);
    return 0;
  }
}

/**
 * Initialize background cron job to check and dispatch due reminders every minute.
 * This only fires while the process is actually running/awake — on a free-tier host
 * that sleeps when idle, /cron/check-reminders (triggered by an external scheduler)
 * is the mechanism that's actually relied on to keep reminders firing on time.
 */
export function initScheduler(): void {
  console.log('⏰ Reminder Scheduler initialized. Polling every minute...');
  cron.schedule('* * * * *', checkAndDispatchReminders);
}
