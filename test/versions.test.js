import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { entryPath } from '../src/adapter.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { listEditions, resolveServiceDay, toEdition } from '../src/timetable.js';
import { readOperations } from '../src/operations.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const query = { route: 'R8', direction: 'outbound' };

function record(edition) {
  return {
    sourceId: edition.editionId,
    source: '公交时刻表目录',
    observedAt: edition.announcedAt,
    label: edition.route,
    attributes: edition,
  };
}

const oldEdition = {
  editionId: 'R8-old', route: 'R8', direction: 'outbound',
  announcedAt: '2026-11-16T08:00:00Z', validFrom: '2026-11-01', validTo: '2026-11-30',
  timezone: 'Asia/Shanghai', departures: ['08:00', '09:00'],
};
const newEdition = {
  editionId: 'R8-new', route: 'R8', direction: 'outbound',
  announcedAt: '2026-11-16T09:00:00Z', validFrom: '2026-11-20', validTo: '2026-12-31',
  timezone: 'Asia/Shanghai', departures: ['08:15', '09:15'], replaces: 'R8-old',
};

async function withCatalogue(run) {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'versions-'));
  try {
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository);
    const client = new SourceClient(source.url);
    await run({ source, service, repository, client });
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('a future announcement does not change today but does apply on its first service day', async () => {
  await withCatalogue(async ({ source, service, client }) => {
    assert.equal((await service.ingestSource(client)).ok, true);
    source.publish('updated');
    assert.equal((await service.ingestSource(client)).ok, true);

    const today = resolveServiceDay(await service.query({}), { ...query, serviceDate: '2026-11-17' });
    assert.equal(today.status, 'resolved');
    assert.equal(today.editionId, 'R8-old');
    assert.deepEqual(today.departures, ['08:00', '09:00']);
    assert.equal(today.query.serviceDate, '2026-11-17');

    const announced = resolveServiceDay(await service.query({}), { ...query, serviceDate: '2026-11-19' });
    assert.equal(announced.editionId, 'R8-old', 'the day before the window still uses the current table');

    const future = resolveServiceDay(await service.query({}), { ...query, serviceDate: '2026-11-20' });
    assert.equal(future.editionId, 'R8-new');
    assert.deepEqual(future.departures, ['08:15', '09:15']);
    assert.equal(future.replaces, 'R8-old');

    const nextWeek = resolveServiceDay(await service.query({}), { ...query, serviceDate: '2026-11-24' });
    assert.equal(nextWeek.editionId, 'R8-new', 'next week shows the newly announced table');
  });
});

test('a stale source cache cannot displace a newer edition in the catalogue or for a day', async () => {
  await withCatalogue(async ({ source, service, client }) => {
    await service.ingestSource(client);
    source.publish('updated');
    await service.ingestSource(client);
    const before = (await service.query({})).map((row) => row.sourceId).sort();
    source.publish('cache');
    const replayed = await service.ingestSource(client);
    assert.equal(replayed.ok, true);
    assert.deepEqual((await service.query({})).map((row) => row.sourceId).sort(), before);
    assert.deepEqual(before, ['R8-new', 'R8-old']);
    const day = resolveServiceDay(await service.query({}), { ...query, serviceDate: '2026-11-24' });
    assert.equal(day.editionId, 'R8-new');
    const cached = resolveServiceDay(await service.query({}), { ...query, serviceDate: '2026-11-17' });
    assert.equal(cached.editionId, 'R8-old');
  });
});

test('a transient source failure keeps the current plan and never withdraws editions', async () => {
  await withCatalogue(async ({ source, service, client }) => {
    await service.ingestSource(client);
    source.publish('updated');
    await service.ingestSource(client);
    const stored = await service.query({});
    for (const fault of [503, 'disconnect']) {
      source.failNext(entryPath, fault);
      const failed = await service.ingestSource(client);
      assert.equal(failed.ok, false);
      assert.equal(failed.accepted, 0);
      assert.ok(failed.error);
      assert.equal(failed.stored, stored.length);
      assert.deepEqual(await service.query({}), stored);
    }
    const today = resolveServiceDay(await service.query({}), { ...query, serviceDate: '2026-11-17' });
    assert.equal(today.editionId, 'R8-old', 'the current table survives the failed read');
  });
});

test('a partial multi-page failure leaves the catalogue untouched', async () => {
  await withCatalogue(async ({ source, service, client }) => {
    await service.ingestSource(client);
    const stored = await service.query({});
    source.publish('paged');
    source.failNext('/timetables?route=R8&page=2', 503);
    const result = await service.ingestSource(client);
    assert.equal(result.ok, false);
    assert.match(result.error, /503/);
    assert.deepEqual(await service.query({}), stored, 'no half batch is persisted');
  });
});

test('source pagination follows next and stores both directions', async () => {
  await withCatalogue(async ({ source, service, client }) => {
    source.publish('paged');
    const result = await service.ingestSource(client);
    assert.equal(result.ok, true);
    assert.equal(result.pages, 2);
    const stored = await service.query({});
    assert.deepEqual(stored.map((row) => row.sourceId).sort(), ['R8-p1', 'R8-p2']);
    assert.equal(resolveServiceDay(stored, { ...query, serviceDate: '2026-11-17' }).editionId, 'R8-p1');
    assert.equal(resolveServiceDay(stored, { route: 'R8', direction: 'inbound', serviceDate: '2026-11-17' }).editionId, 'R8-p2');
  });
});

test('conflicting announcements without a precedence relation refuse to form a timetable', () => {
  const ambiguous = [
    record({ ...oldEdition, editionId: 'R8-a', announcedAt: '2026-11-16T08:00:00Z' }),
    record({ ...oldEdition, editionId: 'R8-b', validFrom: '2026-11-15', validTo: '2026-12-15',
      announcedAt: '2026-11-16T09:00:00Z', departures: ['08:30', '09:30'] }),
  ];
  const day = resolveServiceDay(ambiguous, { ...query, serviceDate: '2026-11-17' });
  assert.equal(day.status, 'conflict');
  assert.equal(day.resolved, false);
  assert.equal(day.departures, null);
  assert.equal(day.editionId, null);
  assert.deepEqual(day.conflictingEditions.sort(), ['R8-a', 'R8-b']);
  assert.equal(day.conflict.reason, 'unresolved_precedence');
  const history = listEditions(ambiguous, { ...query, serviceDate: '2026-11-17' });
  assert.equal(history.resolution.status, 'conflict');
  assert.equal(history.versions.length, 2);
  assert.ok(history.versions.every((version) => version.selected === false));
});

test('a replacement cycle is reported as a conflict instead of being resolved arbitrarily', () => {
  const cycle = [
    record({ ...oldEdition, editionId: 'R8-a', replaces: 'R8-b' }),
    record({ ...oldEdition, editionId: 'R8-b', announcedAt: '2026-11-16T09:00:00Z', replaces: 'R8-a',
      departures: ['10:00'] }),
  ];
  const day = resolveServiceDay(cycle, { ...query, serviceDate: '2026-11-17' });
  assert.equal(day.status, 'conflict');
  assert.equal(day.conflict.reason, 'replacement_cycle');
  assert.deepEqual(day.conflictingEditions.sort(), ['R8-a', 'R8-b']);
});

test('a future replacement does not invalidate the current table before its window', () => {
  const day = resolveServiceDay([record(oldEdition), record(newEdition)],
    { ...query, serviceDate: '2026-11-17' });
  assert.equal(day.editionId, 'R8-old');
  assert.deepEqual(day.alternatives, []);
  const early = resolveServiceDay([record(oldEdition), record(newEdition)],
    { ...query, serviceDate: '2026-11-17', asOf: '2026-11-16T08:30:00Z' });
  assert.equal(early.editionId, 'R8-old', 'a not-yet-announced edition is invisible as of that time');
  const beforeAnnouncement = resolveServiceDay([record(oldEdition), record(newEdition)],
    { ...query, serviceDate: '2026-11-24', asOf: '2026-11-16T08:30:00Z' });
  assert.equal(beforeAnnouncement.editionId, 'R8-old', 'next week would still have shown the old table before the announcement');
});

test('identical maximal editions do not conflict; the latest announcement is recorded', () => {
  const twin = record({ ...newEdition, editionId: 'R8-new-copy', announcedAt: '2026-11-16T10:00:00Z',
    replaces: undefined });
  const first = record({ ...newEdition, editionId: 'R8-new' });
  const day = resolveServiceDay([first, twin], { ...query, serviceDate: '2026-11-24' });
  assert.equal(day.status, 'resolved');
  assert.equal(day.editionId, 'R8-new-copy');
  assert.deepEqual(day.alternatives, ['R8-new']);
});

test('unbounded or unknown service days and malformed records are explained, not guessed', () => {
  const day = resolveServiceDay([record(oldEdition), record(newEdition)],
    { ...query, serviceDate: '2026-12-01' });
  assert.equal(day.status, 'resolved');
  assert.equal(day.editionId, 'R8-new');
  assert.throws(() => resolveServiceDay([], { ...query, serviceDate: '2026-02-30' }), /calendar date/);
  assert.throws(() => resolveServiceDay([], { ...query, serviceDate: 'next monday' }), /YYYY-MM-DD/);
  const missing = resolveServiceDay([record(oldEdition)], { ...query, serviceDate: '2026-10-01' });
  assert.equal(missing.status, 'no_service');
  assert.equal(missing.departures, null);
  const broken = resolveServiceDay([{ sourceId: 'bad', source: 'x', observedAt: '2026-11-16T08:00:00Z',
    label: 'R8', attributes: { editionId: 'bad' } }], { ...query, serviceDate: '2026-11-17' });
  assert.equal(broken.status, 'no_service');
  assert.equal(broken.invalid.length, 1);
});

test('resolution does not depend on catalogue order', () => {
  const records = [record(newEdition), record(oldEdition)];
  const a = resolveServiceDay(records, { ...query, serviceDate: '2026-11-24' });
  const b = resolveServiceDay([...records].reverse(), { ...query, serviceDate: '2026-11-24' });
  assert.deepEqual(a, b);
});

test('toEdition keeps announcement time and the inclusive service-day window', () => {
  const edition = toEdition(record(oldEdition));
  assert.equal(edition.announcedAt, '2026-11-16T08:00:00Z');
  assert.equal(edition.validFrom, '2026-11-01');
  assert.equal(edition.validTo, '2026-11-30');
  assert.notEqual(edition.attributes, record(oldEdition).attributes);
});

test('a replacement cycle announced in either order is still a conflict', () => {
  const cycle = [
    record({ ...oldEdition, editionId: 'R8-a', announcedAt: '2026-11-16T10:00:00Z', replaces: 'R8-b' }),
    record({ ...oldEdition, editionId: 'R8-b', announcedAt: '2026-11-16T09:00:00Z', replaces: 'R8-a',
      departures: ['10:00'] }),
  ];
  assert.equal(resolveServiceDay(cycle, { ...query, serviceDate: '2026-11-17' }).status, 'conflict');
});

test('a replacement announced before its target competes instead of silently winning', () => {
  const backwards = record({ ...oldEdition, editionId: 'R8-a', announcedAt: '2026-11-16T07:00:00Z',
    replaces: 'R8-b' });
  const target = record({ ...oldEdition, editionId: 'R8-b', announcedAt: '2026-11-16T09:00:00Z',
    departures: ['10:00'] });
  const day = resolveServiceDay([backwards, target], { ...query, serviceDate: '2026-11-17' });
  assert.equal(day.status, 'conflict');
  assert.deepEqual(day.conflictingEditions, ['R8-a', 'R8-b']);
});

test('replacement precedence is transitive across an expired intermediate edition', () => {
  const base = record({ ...oldEdition, editionId: 'R8-base', validFrom: '2026-11-01', validTo: '2026-11-30' });
  const middle = record({ ...oldEdition, editionId: 'R8-mid', validFrom: '2026-11-01', validTo: '2026-11-10',
    announcedAt: '2026-11-16T09:00:00Z', replaces: 'R8-base', departures: ['07:00'] });
  const latest = record({ ...oldEdition, editionId: 'R8-latest', validFrom: '2026-11-01', validTo: '2026-11-30',
    announcedAt: '2026-11-16T10:00:00Z', replaces: 'R8-mid', departures: ['11:00'] });
  const day = resolveServiceDay([base, middle, latest], { ...query, serviceDate: '2026-11-17' });
  assert.equal(day.status, 'resolved');
  assert.equal(day.editionId, 'R8-latest');
  assert.equal(day.departures[0], '11:00');
});

test('an expired edition that is not replaced by a valid one is ignored, not merged', () => {
  const expired = record({ ...oldEdition, editionId: 'R8-expired', validFrom: '2026-10-01', validTo: '2026-11-10' });
  const replacement = record({ ...newEdition, editionId: 'R8-next', validFrom: '2026-11-20', replaces: 'R8-expired' });
  const day = resolveServiceDay([expired, replacement], { ...query, serviceDate: '2026-11-17' });
  assert.equal(day.status, 'no_service');
  assert.equal(day.departures, null);
});

test('readOperations keeps the legacy rows and adds the service-day explanation', async () => {
  const records = [record(oldEdition), record(newEdition)];
  const repository = { read: async () => records };
  const legacy = await readOperations(repository);
  assert.deepEqual(Object.keys(legacy).sort(), ['product', 'rows']);
  assert.equal(legacy.rows.length, 2);
  assert.equal(legacy.rows[0].attributes.editionId, 'R8-old');
  const scoped = await readOperations(repository, { ...query, serviceDate: '2026-11-17' });
  assert.equal(scoped.rows.length, 2);
  assert.equal(scoped.serviceDay.editionId, 'R8-old');
  assert.equal(scoped.serviceDay.resolved, true);
  const conflicting = await readOperations({ read: async () => [
    record({ ...oldEdition, editionId: 'R8-a' }),
    record({ ...oldEdition, editionId: 'R8-b', validFrom: '2026-11-15', departed: true,
      departures: ['23:00'], announcedAt: '2026-11-16T09:00:00Z' }),
  ] }, { ...query, serviceDate: '2026-11-17' });
  assert.equal(conflicting.serviceDay.status, 'conflict');
  assert.equal(conflicting.serviceDay.departures, null);
});
