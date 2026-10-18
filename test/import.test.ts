/**
 * User import: merging accounts across media servers and phone number normalization.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { User } from '../src/db/repo.js';
import { mergeAccounts, normalizePhone } from '../src/server/userImport.js';

const jf = (id: string, name: string) => ({ id, name, admin: false, disabled: false });

test('Jellyseerr bridges Jellyfin and Plex accounts of the same person', () => {
  const out = mergeAccounts(
    {
      jellyfin: [jf('a', 'max'), jf('b', 'lisa')],
      plex: [{ id: 1, username: 'max_m', owner: false }, { id: 2, username: 'jonas', email: 'jonas@x.de', owner: false }],
      seerr: [
        { id: 5, displayName: 'Max Mustermann', jellyfinUsername: 'max', plexUsername: 'max_m' },
        { id: 7, displayName: 'Jonas W.', email: 'Jonas@x.de' },
      ],
    },
    [],
  );
  assert.equal(out.length, 3);
  const max = out.find((c) => c.jellyfin?.name === 'max')!;
  assert.equal(max.name, 'Max Mustermann');
  assert.equal(max.plex?.username, 'max_m');
  assert.equal(max.seerr?.id, 5);
  const jonas = out.find((c) => c.plex?.username === 'jonas')!;
  assert.equal(jonas.seerr?.id, 7, 'matched by e-mail, case-insensitive');
  assert.equal(out.find((c) => c.jellyfin?.name === 'lisa')?.plex, undefined);
});

test('accounts already linked to a bot user are marked and sorted last', () => {
  const anna = { id: 9, wa_id: '4915112345678', display_name: 'Anna', push_name: null, jellyfin_user_id: null, jellyfin_username: 'Anna', plex_username: null, seerr_user_id: null } as unknown as User;
  const out = mergeAccounts({ jellyfin: [jf('a', 'anna'), jf('b', 'zoe')] }, [anna]);
  assert.deepEqual(
    out.map((c) => [c.name, c.existing?.id]),
    [
      ['zoe', undefined],
      ['anna', 9],
    ],
  );
});

test('phone numbers need a country code', () => {
  assert.deepEqual(normalizePhone('+49 151 1234-5678'), { phone: '4915112345678' });
  assert.deepEqual(normalizePhone('0049 (151) 12345678'), { phone: '4915112345678' });
  assert.deepEqual(normalizePhone('4915112345678'), { phone: '4915112345678' });
  assert.ok('error' in normalizePhone('0151 12345678'));
  assert.ok('error' in normalizePhone('+49 abc'));
  assert.ok('error' in normalizePhone('+49 15'));
});
