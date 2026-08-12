import { getAllUsers, markDigestSent, getUserTasks, getUserPendingReminders } from './supabase';
import { sendWhatsAppMessage, sendWhatsAppTemplate } from './whatsapp';
import { getLocalDateAndHour } from '../utils/timezone';
import { formatTaskList, formatReminderList } from '../utils/formatting';

const DIGEST_HOUR = 8; // send each user's digest at 8am in their own local time

/**
 * Send a proactive "good morning" digest of today's tasks and active reminders to
 * every user whose local time has just turned 8am and hasn't had one yet today.
 * Skips silently (but still marks the day checked) for users with nothing active,
 * so nobody gets an empty "you have nothing today" message every morning.
 */
export async function checkAndSendDailyDigests(): Promise<number> {
  const users = await getAllUsers();
  let sentCount = 0;

  for (const user of users) {
    if (!user.id) continue;

    const timezone = user.timezone || 'Africa/Kigali';
    const { date: localDate, hour: localHour } = getLocalDateAndHour(timezone);

    if (localHour !== DIGEST_HOUR) continue;
    if (user.last_digest_date === localDate) continue;

    try {
      const [tasks, reminders] = await Promise.all([getUserTasks(user.id), getUserPendingReminders(user.id)]);

      if (tasks.length === 0 && reminders.length === 0) {
        await markDigestSent(user.id, localDate);
        continue;
      }

      const sections: string[] = [];
      if (tasks.length > 0) sections.push(`📋 *Tasks:*\n${formatTaskList(tasks, timezone)}`);
      if (reminders.length > 0) sections.push(`⏰ *Reminders:*\n${formatReminderList(reminders, timezone)}`);

      const digestBody = `Good morning, ${user.name || 'there'}! Here's your day:\n\n${sections.join('\n\n')}`;

      let sent = await sendWhatsAppTemplate(user.phone_number, 'daily_digest', 'en', { digest_body: digestBody });
      if (!sent) {
        sent = await sendWhatsAppMessage(user.phone_number, `☀️ ${digestBody}`);
      }

      if (sent) {
        console.log(`✅ Sent daily digest to ${user.phone_number}`);
        sentCount++;
      } else {
        console.error(`❌ Failed to send daily digest to ${user.phone_number}`);
      }

      await markDigestSent(user.id, localDate);
    } catch (error: any) {
      console.error(`❌ Error building/sending digest for ${user.phone_number}:`, error.message);
    }
  }

  return sentCount;
}
