import { Task, Reminder } from '../types';

/** Human-readable date/time in the user's timezone, e.g. "Wed, Aug 12, 6:00 PM". */
export function formatFriendlyDateTime(iso: string, timezone: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

/** Formats a user's active task list for display (caller supplies any header). */
export function formatTaskList(tasks: Task[], timezone: string): string {
  if (tasks.length === 0) return 'Your daily task list is currently empty!';
  return tasks
    .map((t, i) => `${i + 1}. *${t.title}*${t.due_date ? ` — due ${formatFriendlyDateTime(t.due_date, timezone)}` : ''}`)
    .join('\n');
}

/** Formats a user's active reminder list for display (caller supplies any header). */
export function formatReminderList(reminders: Reminder[], timezone: string): string {
  if (reminders.length === 0) return 'You have no active reminders right now!';
  return reminders
    .map((r, i) => `${i + 1}. "${r.message}" — ${formatFriendlyDateTime(r.remind_at, timezone)}${r.recurrence ? ` (repeats ${r.recurrence})` : ''}`)
    .join('\n');
}
