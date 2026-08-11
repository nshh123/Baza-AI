import cron from 'node-cron';
import { getDueReminders, markReminderSent } from './supabase';
import { sendWhatsAppMessage } from './whatsapp';

/**
 * Initialize background cron job to check and dispatch due reminders every minute
 */
export function initScheduler(): void {
  console.log('⏰ Reminder Scheduler initialized. Polling every minute...');

  // Run every minute: '* * * * *'
  cron.schedule('* * * * *', async () => {
    try {
      const dueReminders = await getDueReminders();

      if (dueReminders.length === 0) return;

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
    } catch (error: any) {
      console.error('❌ Error running reminder scheduler cron:', error.message);
    }
  });
}
