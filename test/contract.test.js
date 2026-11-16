import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('new timetable has a future service-day window and explicit replacement', async () => {
  const initial = (await observe()).records[0].attributes;
  const upcoming = (await observe('updated')).records[0].attributes;
  assert.equal(upcoming.replaces, initial.editionId);
  assert.equal(upcoming.validFrom, '2026-11-20');
  assert.equal(initial.timezone, 'Asia/Shanghai');
  assert.notDeepEqual(initial.departures, upcoming.departures);
});
