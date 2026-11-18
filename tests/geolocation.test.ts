import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPublicIpAddress, OfflineGeolocation } from '../server/geolocation';

const cityDatabase = path.resolve('tests/fixtures/maxmind/GeoIP2-City-Test.mmdb');
const asnDatabase = path.resolve('tests/fixtures/maxmind/GeoLite2-ASN-Test.mmdb');

describe('offline IP geolocation', () => {
  it('excludes private, reserved, documentation and invalid addresses', () => {
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('2001:4860:4860::8888')).toBe(true);
    expect(isPublicIpAddress('::ffff:8.8.8.8')).toBe(true);
    for (const address of ['127.0.0.1', '10.0.0.1', '172.20.0.1', '192.168.1.1', '169.254.169.254', '203.0.113.10', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:192.168.1.1', 'not-an-ip'])
      expect(isPublicIpAddress(address), address).toBe(false);
  });

  it('returns private and unavailable states without contacting a service', async () => {
    const lookup = new OfflineGeolocation();
    await expect(lookup.lookup('192.168.0.4')).resolves.toEqual({ ip: '192.168.0.4', status: 'private' });
    await expect(lookup.lookup('::ffff:192.168.0.4')).resolves.toEqual({ ip: '::ffff:192.168.0.4', status: 'private' });
    await expect(lookup.lookup('8.8.8.8')).resolves.toEqual({ ip: '8.8.8.8', status: 'unavailable' });
  });

  it('validates local database types and returns city, ASN, update date and estimated time zone', async () => {
    const lookup = new OfflineGeolocation();
    const city = await lookup.configure('city', cityDatabase);
    const asn = await lookup.configure('asn', asnDatabase);
    expect(city).toMatchObject({ configured: true, databaseType: 'GeoIP2-City' });
    expect(asn).toMatchObject({ configured: true, databaseType: 'GeoLite2-ASN' });
    expect(city.updatedAt).toMatch(/^2026-/);
    await expect(lookup.configure('city', asnDatabase)).rejects.toThrow('City database');

    await expect(lookup.lookup('81.2.69.142')).resolves.toMatchObject({
      ip: '81.2.69.142', status: 'found', city: 'London', country: 'United Kingdom',
      countryCode: 'GB', region: 'England', timeZone: 'Europe/London', accuracyRadiusKm: 10,
      source: 'GeoIP2-City',
    });
    await expect(lookup.lookup('1.0.0.1')).resolves.toMatchObject({
      ip: '1.0.0.1', status: 'found', asn: 15169, organization: 'Google Inc.',
      source: 'GeoLite2-ASN',
    });
  });

  it('keeps unknown public addresses unknown and supports removing a local database', async () => {
    const lookup = new OfflineGeolocation({ city: cityDatabase });
    await expect(lookup.lookup('8.8.8.8')).resolves.toMatchObject({ ip: '8.8.8.8', status: 'not-found' });
    expect((await lookup.configure('city')).configured).toBe(false);
    await expect(lookup.lookup('8.8.8.8')).resolves.toMatchObject({ ip: '8.8.8.8', status: 'unavailable' });
  });

  it('reports a configured but missing local database as unavailable', async () => {
    const lookup = new OfflineGeolocation({ city: path.resolve('tests/fixtures/maxmind/missing-city.mmdb') });
    await expect(lookup.lookup('8.8.8.8')).resolves.toMatchObject({ ip: '8.8.8.8', status: 'unavailable' });
  });
});
