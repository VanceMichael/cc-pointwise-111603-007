import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readServiceDay } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const repository = new RecordRepository(join(directory, 'records.json'));
  const service = new CollectionService(repository);
  const client = new SourceClient(source.url);
  await service.ingestSource(client);
  source.publish('updated');
  await service.ingestSource(client);
  const query = { route: 'R8', direction: 'outbound' };
  const today = await readServiceDay(repository, { ...query, serviceDate: '2026-11-17' });
  const nextWeek = await readServiceDay(repository, { ...query, serviceDate: '2026-11-24' });
  console.log(JSON.stringify({
    catalogue: (await service.query({})).map((record) => record.sourceId).sort(),
    today: {
      serviceDate: today.query.serviceDate,
      editionId: today.editionId,
      announcedAt: today.announcedAt,
      departures: today.departures,
    },
    nextWeek: {
      serviceDate: nextWeek.query.serviceDate,
      editionId: nextWeek.editionId,
      announcedAt: nextWeek.announcedAt,
      departures: nextWeek.departures,
    },
  }, null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
