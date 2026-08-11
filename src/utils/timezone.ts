/**
 * Calling-code prefix -> IANA timezone, longest prefix first so e.g. "254" (Kenya)
 * is checked before "25" would ever wrongly match. Countries spanning multiple
 * timezones (US, Russia, Australia, Brazil, Canada) default to their most populous
 * one — this is a best-effort guess for a sensible default, not a precise lookup.
 * Users can correct it conversationally via the set_timezone tool.
 */
const RAW_CALLING_CODE_TIMEZONES: [string, string][] = [
  ['211', 'Africa/Juba'], ['212', 'Africa/Casablanca'], ['213', 'Africa/Algiers'],
  ['216', 'Africa/Tunis'], ['218', 'Africa/Tripoli'], ['220', 'Africa/Banjul'],
  ['221', 'Africa/Dakar'], ['222', 'Africa/Nouakchott'], ['223', 'Africa/Bamako'],
  ['224', 'Africa/Conakry'], ['225', 'Africa/Abidjan'], ['226', 'Africa/Ouagadougou'],
  ['227', 'Africa/Niamey'], ['228', 'Africa/Lome'], ['229', 'Africa/Porto-Novo'],
  ['230', 'Indian/Mauritius'], ['231', 'Africa/Monrovia'], ['232', 'Africa/Freetown'],
  ['233', 'Africa/Accra'], ['234', 'Africa/Lagos'], ['235', 'Africa/Ndjamena'],
  ['236', 'Africa/Bangui'], ['237', 'Africa/Douala'], ['238', 'Atlantic/Cape_Verde'],
  ['239', 'Africa/Sao_Tome'], ['240', 'Africa/Malabo'], ['241', 'Africa/Libreville'],
  ['242', 'Africa/Brazzaville'], ['243', 'Africa/Kinshasa'], ['244', 'Africa/Luanda'],
  ['245', 'Africa/Bissau'], ['248', 'Indian/Mahe'], ['249', 'Africa/Khartoum'],
  ['250', 'Africa/Kigali'], ['251', 'Africa/Addis_Ababa'], ['252', 'Africa/Mogadishu'],
  ['253', 'Africa/Djibouti'], ['254', 'Africa/Nairobi'], ['255', 'Africa/Dar_es_Salaam'],
  ['256', 'Africa/Kampala'], ['257', 'Africa/Bujumbura'], ['258', 'Africa/Maputo'],
  ['260', 'Africa/Lusaka'], ['261', 'Indian/Antananarivo'], ['262', 'Indian/Reunion'],
  ['263', 'Africa/Harare'], ['264', 'Africa/Windhoek'], ['265', 'Africa/Blantyre'],
  ['266', 'Africa/Maseru'], ['267', 'Africa/Gaborone'], ['268', 'Africa/Mbabane'],
  ['269', 'Indian/Comoro'],
  ['351', 'Europe/Lisbon'], ['352', 'Europe/Luxembourg'], ['353', 'Europe/Dublin'],
  ['354', 'Atlantic/Reykjavik'], ['355', 'Europe/Tirane'], ['356', 'Europe/Malta'],
  ['357', 'Asia/Nicosia'], ['358', 'Europe/Helsinki'], ['359', 'Europe/Sofia'],
  ['370', 'Europe/Vilnius'], ['371', 'Europe/Riga'], ['372', 'Europe/Tallinn'],
  ['373', 'Europe/Chisinau'], ['374', 'Asia/Yerevan'], ['375', 'Europe/Minsk'],
  ['376', 'Europe/Andorra'], ['377', 'Europe/Monaco'], ['378', 'Europe/San_Marino'],
  ['380', 'Europe/Kyiv'], ['381', 'Europe/Belgrade'], ['385', 'Europe/Zagreb'],
  ['386', 'Europe/Ljubljana'], ['420', 'Europe/Prague'], ['421', 'Europe/Bratislava'],
  ['423', 'Europe/Vaduz'],
  ['880', 'Asia/Dhaka'], ['960', 'Indian/Maldives'], ['961', 'Asia/Beirut'],
  ['962', 'Asia/Amman'], ['963', 'Asia/Damascus'], ['964', 'Asia/Baghdad'],
  ['965', 'Asia/Kuwait'], ['966', 'Asia/Riyadh'], ['967', 'Asia/Aden'],
  ['968', 'Asia/Muscat'], ['970', 'Asia/Gaza'], ['971', 'Asia/Dubai'],
  ['972', 'Asia/Jerusalem'], ['973', 'Asia/Bahrain'], ['974', 'Asia/Qatar'],
  ['975', 'Asia/Thimphu'], ['976', 'Asia/Ulaanbaatar'], ['977', 'Asia/Kathmandu'],
  ['992', 'Asia/Dushanbe'], ['993', 'Asia/Ashgabat'], ['994', 'Asia/Baku'],
  ['995', 'Asia/Tbilisi'], ['996', 'Asia/Bishkek'], ['998', 'Asia/Tashkent'],
  ['20', 'Africa/Cairo'], ['27', 'Africa/Johannesburg'], ['30', 'Europe/Athens'],
  ['31', 'Europe/Amsterdam'], ['32', 'Europe/Brussels'], ['33', 'Europe/Paris'],
  ['34', 'Europe/Madrid'], ['36', 'Europe/Budapest'], ['39', 'Europe/Rome'],
  ['40', 'Europe/Bucharest'], ['41', 'Europe/Zurich'], ['44', 'Europe/London'],
  ['45', 'Europe/Copenhagen'], ['46', 'Europe/Stockholm'], ['47', 'Europe/Oslo'],
  ['48', 'Europe/Warsaw'], ['49', 'Europe/Berlin'], ['51', 'America/Lima'],
  ['52', 'America/Mexico_City'], ['53', 'America/Havana'], ['54', 'America/Argentina/Buenos_Aires'],
  ['55', 'America/Sao_Paulo'], ['56', 'America/Santiago'], ['57', 'America/Bogota'],
  ['58', 'America/Caracas'], ['60', 'Asia/Kuala_Lumpur'], ['61', 'Australia/Sydney'],
  ['62', 'Asia/Jakarta'], ['63', 'Asia/Manila'], ['64', 'Pacific/Auckland'],
  ['65', 'Asia/Singapore'], ['66', 'Asia/Bangkok'], ['81', 'Asia/Tokyo'],
  ['82', 'Asia/Seoul'], ['84', 'Asia/Ho_Chi_Minh'], ['86', 'Asia/Shanghai'],
  ['90', 'Europe/Istanbul'], ['91', 'Asia/Kolkata'], ['92', 'Asia/Karachi'],
  ['93', 'Asia/Kabul'], ['94', 'Asia/Colombo'], ['95', 'Asia/Yangon'],
  ['98', 'Asia/Tehran'],
  ['1', 'America/New_York'], ['7', 'Europe/Moscow'],
];

const CALLING_CODE_TIMEZONES: [string, string][] = [...RAW_CALLING_CODE_TIMEZONES].sort(
  (a, b) => b[0].length - a[0].length
);

/**
 * Best-effort default timezone guess from an E.164 phone number (no leading '+').
 * Returns 'UTC' if no calling code matches.
 */
export function guessTimezoneFromPhone(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  for (const [code, tz] of CALLING_CODE_TIMEZONES) {
    if (digits.startsWith(code)) return tz;
  }
  return 'UTC';
}

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
