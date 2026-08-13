import { Task, Reminder } from '../types';

/**
 * Gemini is instructed to use WhatsApp's single-asterisk bold syntax, but as an LLM
 * trained heavily on standard Markdown it still slips into standard Markdown output
 * sometimes (especially in lists): double-delimiter bold, and "* "/"- " unordered
 * list markers, neither of which WhatsApp understands as formatting. Double
 * delimiters don't render as a unit — WhatsApp pairs off the innermost single
 * asterisks as bold and leaves the outer ones as literal characters, e.g.
 * "**Century Cinema**" renders as a stray "*" next to a shorter bolded span. And a
 * bare "* " list marker just shows up as a literal asterisk with no indentation,
 * since WhatsApp has no list syntax at all. Normalize both to WhatsApp's actual
 * capabilities — "*text*" bold and a "•" bullet with manual indentation — before
 * sending, since prompt instructions alone aren't reliable for this.
 */
export function toWhatsAppFormatting(text: string): string {
  return text
    .replace(/^[ \t]*([*-])(?!\*)\s+/gm, '   • ')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*');
}

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
