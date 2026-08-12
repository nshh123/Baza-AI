/** Validates that a string is a real IANA timezone name Node/Intl recognizes. */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Human-readable current local time in the given timezone, for prompting Gemini. */
export function getLocalTimeString(timezone: string): string {
  try {
    return new Date().toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' });
  } catch {
    return new Date().toISOString() + ' (UTC)';
  }
}

/**
 * The current local date (YYYY-MM-DD) and hour (0-23) in the given timezone —
 * used to decide "is it this user's local morning yet" without any date-math bugs
 * around DST or fractional UTC offsets.
 */
export function getLocalDateAndHour(timezone: string): { date: string; hour: number } {
  try {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date())
    );
    return { date, hour };
  } catch {
    const now = new Date();
    return { date: now.toISOString().slice(0, 10), hour: now.getUTCHours() };
  }
}
