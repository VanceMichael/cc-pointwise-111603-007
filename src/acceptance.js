import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations, readServiceDay, readVersionHistory } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const service = new CollectionService(repository);
  const client = new SourceClient(source.url);
  const query = { route: 'R8', direction: 'outbound' };

  const first = await service.ingestSource(client);
  assert.equal(first.ok, true);
  assert.ok(first.accepted > 0, '初始来源须有可接收的业务记录');
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');

  source.publish('updated');
  const second = await service.ingestSource(client);
  assert.equal(second.ok, true);
  const catalogue = await reopened.read();
  assert.deepEqual(catalogue.map(record => record.sourceId).sort(), ['R8-new', 'R8-old'],
    '未来公告与现行表都保留，不互相覆盖');

  const today = await readServiceDay(reopened, { ...query, serviceDate: '2026-11-17' });
  assert.equal(today.status, 'resolved');
  assert.equal(today.editionId, 'R8-old', '今日仍用现行表');
  const nextWeek = await readServiceDay(reopened, { ...query, serviceDate: '2026-11-24' });
  assert.equal(nextWeek.editionId, 'R8-new', '下周按已公告的新表');

  source.publish('cache');
  const cached = await service.ingestSource(client);
  assert.equal(cached.ok, true);
  assert.deepEqual((await reopened.read()).map(record => record.sourceId).sort(),
    ['R8-new', 'R8-old'], '旧缓存回流不能删除或替换新版本');

  source.failNext(entryPath, 503);
  const failed = await service.ingestSource(client);
  assert.equal(failed.ok, false);
  assert.equal(failed.stored, 2, '来源临时不可读时保留现行计划');
  assert.equal((await service.query({})).length, 2);

  const history = await readVersionHistory(reopened, { ...query, serviceDate: '2026-11-17' });
  assert.equal(history.versions.length, 2);
  assert.deepEqual(history.versions.filter(version => version.selected)
    .map(version => version.editionId), ['R8-old']);
  assert.equal(history.resolution.editionId, 'R8-old');

  const business = await readOperations(reopened, { ...query, serviceDate: '2026-11-24' });
  assert.equal(business.serviceDay.editionId, 'R8-new');
  assert.equal(business.serviceDay.announcedAt, '2026-11-16T09:00:00Z');
  assert.equal(business.rows.length, 2);

  console.log(JSON.stringify({
    accepted: first.accepted,
    persisted: stored.length,
    today: today.editionId,
    nextWeek: nextWeek.editionId,
    afterCache: cached.stored,
    afterFailure: failed.stored,
    history: history.versions.length,
    operationRows: business.rows.length,
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
