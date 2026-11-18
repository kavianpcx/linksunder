/** Display a run timestamp in the browser's locale and time zone by default. */
export function formatRunTimestamp(value: string, locale?: string, timeZone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  const preference = timeZone || (typeof window !== 'undefined' && window.localStorage.getItem('timeZone') === 'UTC' ? 'UTC' : undefined);

  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
    timeZone: preference,
  }).format(date);
}
