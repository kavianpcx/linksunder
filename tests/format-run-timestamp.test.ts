import { expect, it } from 'vitest';
import { formatRunTimestamp } from '../client/format-run-timestamp';

it('formats a known timestamp in the selected locale and time zone', () => {
  const timestamp = '2026-10-01T13:04:05.000Z';
  expect(formatRunTimestamp(timestamp, 'en-GB', 'UTC')).toBe('1 Oct 2026, 13:04:05 UTC');
  expect(formatRunTimestamp(timestamp, 'en-GB', 'Asia/Kolkata')).toBe(
    '1 Oct 2026, 18:34:05 GMT+5:30',
  );
  expect(formatRunTimestamp(timestamp, 'en-GB', 'Asia/Tehran')).toBe(
    '1 Oct 2026, 16:34:05 GMT+3:30',
  );
});

it('returns a readable fallback for invalid timestamps', () => {
  expect(formatRunTimestamp('invalid', 'en-GB', 'UTC')).toBe('Unavailable');
});

it('falls back to local time for an invalid saved time zone', () => {
  const timestamp = '2026-10-01T13:04:05.000Z';
  expect(formatRunTimestamp(timestamp, 'en-GB', 'No/Such_Region')).not.toBe('Unavailable');
});
