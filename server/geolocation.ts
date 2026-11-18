import { lstat } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import maxmind, { type AsnResponse, type CityResponse, type Reader } from 'maxmind';
import type { GeolocationDatabaseInfo, GeolocationRecord } from '../shared/network.js';

export type GeolocationDatabaseKind = 'city' | 'asn';

const reserved = new BlockList();
for (const [range, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) reserved.addSubnet(range, prefix, 'ipv4');
for (const [range, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001:db8::', 32], ['2001:10::', 28], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) reserved.addSubnet(range, prefix, 'ipv6');

function mappedIpv4(address: string) {
  const normalized = address.toLowerCase();
  const dotted = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  const expandedInput = dotted
    ? normalized.replace(dotted, (() => {
      const octets = dotted.split('.').map(Number);
      return `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    })())
    : normalized;
  const halves = expandedInput.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right].map((group) => group.padStart(4, '0'));
  if (groups.length !== 8 || groups.slice(0, 5).some((group) => group !== '0000') || groups[5] !== 'ffff') return undefined;
  const tail = groups.slice(6).flatMap((group) => [parseInt(group.slice(0, 2), 16), parseInt(group.slice(2), 16)]);
  return tail.join('.');
}

export function isPublicIpAddress(address: string) {
  const family = isIP(address);
  if (family !== 4 && family !== 6) return false;
  if (family === 6) {
    const mapped = mappedIpv4(address);
    return mapped ? !reserved.check(mapped, 'ipv4') : !reserved.check(address, 'ipv6');
  }
  return !reserved.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function englishName(value?: { names?: { en?: string } }) {
  return value?.names?.en;
}

export class OfflineGeolocation {
  private paths: Record<GeolocationDatabaseKind, string | undefined>;
  private cityReader?: Reader<CityResponse>;
  private asnReader?: Reader<AsnResponse>;
  private cityOpen?: Promise<Reader<CityResponse> | undefined>;
  private asnOpen?: Promise<Reader<AsnResponse> | undefined>;

  constructor(paths: Partial<Record<GeolocationDatabaseKind, string>> = {}) {
    this.paths = { city: paths.city, asn: paths.asn };
  }

  setPath(kind: GeolocationDatabaseKind, file?: string) {
    this.paths[kind] = file;
    if (kind === 'city') {
      this.cityReader = undefined;
      this.cityOpen = undefined;
    } else {
      this.asnReader = undefined;
      this.asnOpen = undefined;
    }
  }

  private async readerFor(kind: GeolocationDatabaseKind) {
    if (kind === 'city') {
      if (this.cityReader) return this.cityReader;
      if (this.cityOpen) return this.cityOpen;
      const file = this.paths.city;
      if (!file) return undefined;
      this.cityOpen = maxmind.open<CityResponse>(file).then((reader) => {
        if (!reader.metadata.databaseType.endsWith('-City')) throw new Error('Choose a MaxMind City .mmdb database.');
        this.cityReader = reader;
        return reader;
      }).catch(() => undefined).finally(() => { this.cityOpen = undefined; });
      return this.cityOpen;
    }
    if (this.asnReader) return this.asnReader;
    if (this.asnOpen) return this.asnOpen;
    const file = this.paths.asn;
    if (!file) return undefined;
    this.asnOpen = maxmind.open<AsnResponse>(file).then((reader) => {
      if (!reader.metadata.databaseType.endsWith('-ASN')) throw new Error('Choose a MaxMind ASN .mmdb database.');
      this.asnReader = reader;
      return reader;
    }).catch(() => undefined).finally(() => { this.asnOpen = undefined; });
    return this.asnOpen;
  }

  async configure(kind: GeolocationDatabaseKind, databasePath?: string) {
    if (!databasePath) {
      this.setPath(kind);
      return this.getInfo(kind);
    }
    const resolved = path.resolve(databasePath);
    if (!path.isAbsolute(databasePath) || path.extname(resolved).toLowerCase() !== '.mmdb')
      throw new Error('Choose an absolute path to a .mmdb database file.');
    const info = await lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The selected database must be a regular .mmdb file.');
    const reader = kind === 'city'
      ? await maxmind.open<CityResponse>(resolved)
      : await maxmind.open<AsnResponse>(resolved);
    const expected = kind === 'city' ? /-City$/ : /-ASN$/;
    if (!expected.test(reader.metadata.databaseType))
      throw new Error(kind === 'city' ? 'Choose a MaxMind City database, such as GeoLite2-City.mmdb.' : 'Choose a MaxMind ASN database, such as GeoLite2-ASN.mmdb.');
    this.setPath(kind, resolved);
    if (kind === 'city') {
      this.cityReader = reader as Reader<CityResponse>;
    } else {
      this.asnReader = reader as Reader<AsnResponse>;
    }
    return this.getInfo(kind);
  }

  getInfo(kind: GeolocationDatabaseKind): GeolocationDatabaseInfo {
    const reader = kind === 'city' ? this.cityReader : this.asnReader;
    return {
      kind,
      configured: Boolean(this.paths[kind]),
      path: this.paths[kind],
      databaseType: reader?.metadata.databaseType,
      updatedAt: reader?.metadata.buildEpoch?.toISOString(),
    };
  }

  getAllInfo() {
    return { city: this.getInfo('city'), asn: this.getInfo('asn') };
  }

  async lookup(address: string): Promise<GeolocationRecord> {
    if (!isPublicIpAddress(address)) return { ip: address, status: 'private' };
    if (!this.paths.city && !this.paths.asn) return { ip: address, status: 'unavailable' };
    const lookupAddress = mappedIpv4(address) || address;
    const [cityReader, asnReader] = await Promise.all([this.readerFor('city'), this.readerFor('asn')]);
    if ((this.paths.city && !cityReader) || (this.paths.asn && !asnReader))
      return { ip: address, status: 'unavailable' };
    const city = cityReader?.get(lookupAddress) as CityResponse | null | undefined;
    const asn = asnReader?.get(lookupAddress) as AsnResponse | null | undefined;
    if (!city && !asn) return { ip: address, status: 'not-found' };
    const cityType = cityReader?.metadata.databaseType;
    const asnType = asnReader?.metadata.databaseType;
    return {
      ip: address,
      status: 'found',
      country: englishName(city?.country),
      countryCode: city?.country?.iso_code,
      region: englishName(city?.subdivisions?.[0]),
      city: englishName(city?.city),
      accuracyRadiusKm: city?.location?.accuracy_radius,
      timeZone: city?.location?.time_zone,
      asn: asn?.autonomous_system_number,
      organization: asn?.autonomous_system_organization,
      source: [city && cityType, asn && asnType].filter(Boolean).join(' + '),
      cityDatabaseDate: cityReader?.metadata.buildEpoch?.toISOString(),
      asnDatabaseDate: asnReader?.metadata.buildEpoch?.toISOString(),
    };
  }
}
