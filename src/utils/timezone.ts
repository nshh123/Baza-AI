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
