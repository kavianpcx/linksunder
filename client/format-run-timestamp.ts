/** Display a run timestamp in the browser's locale and time zone by default. */
export function formatRunTimestamp(value: string, locale?: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  let preference = timeZone;
  if (preference === undefined && typeof window !== 'undefined') {
    try {
      preference = window.localStorage.getItem('timeZone') || undefined;
    } catch {
      preference = undefined;
    }
  }
  if (preference === 'local') preference = undefined;

  let resolvedTimeZone: string | undefined;
  if (preference) {
    try {
      resolvedTimeZone = new Intl.DateTimeFormat(locale, { timeZone: preference }).resolvedOptions().timeZone;
    } catch {
      resolvedTimeZone = undefined;
    }
  }

  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
    timeZone: resolvedTimeZone,
  }).format(date);
}
