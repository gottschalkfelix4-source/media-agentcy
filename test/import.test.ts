/**
 * User import: merging accounts across media servers and phone number normalization.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { User } from '../src/db/repo.js';
import { parseTvUsers } from '../src/integrations/plex.js';
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

test('plex.tv friend list (v1 XML) is parsed, entities decoded', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="myPlex" identifier="com.plexapp.plugins.myplex" machineIdentifier="x" totalSize="2" size="2">
  <User id="11" title="max_m" username="max_m" email="max@example.com" recommendationsPlaylistId="" thumb="https://plex.tv/users/a/avatar" protected="0" home="0" restricted="0">
    <Server id="1" serverId="2" machineIdentifier="m" name="Kino" lastSeenAt="1" numLibraries="3" allLibraries="1" owned="1" pending="0"/>
  </User>
  <User id="12" title="Oma &amp; Opa" username="" email="" home="1" restricted="1"/>
</MediaContainer>`;
  assert.deepEqual(parseTvUsers(xml), [
    { id: 11, title: 'max_m', username: 'max_m', email: 'max@example.com' },
    { id: 12, title: 'Oma & Opa', username: '', email: '' },
  ]);
  assert.deepEqual(parseTvUsers({ MediaContainer: { User: [{ id: 3, title: 'jonas' }] } }), [{ id: 3, title: 'jonas' }]);
});
