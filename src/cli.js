import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { SourceClient } from './source-client.js';
import { entryPath } from './adapter.js';
import { readOperations, readServiceDay, readVersionHistory } from './operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const service = new CollectionService(new RecordRepository(resolve(here, '../var/records.json')));
const [action, ...rest] = process.argv.slice(2);
const positional = [];
const options = {};
for (let index = 0; index < rest.length; index += 1) {
  const argument = rest[index];
  if (argument.startsWith('--')) {
    const [key, ...valueParts] = argument.slice(2).split('=');
    const inline = valueParts.length ? valueParts.join('=') : null;
    if (inline != null) options[key] = inline;
    else if (rest[index + 1] != null && !rest[index + 1].startsWith('--')) options[key] = rest[++index];
    else options[key] = true;
  } else {
    positional.push(argument);
  }
}

if (!action || action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | sync <来源地址> [路径] | versions --route <线路> --direction <方向> [--date <服务日>] | day --route <线路> --direction <方向> --date <服务日> [--as-of <公告截止时间>]',
    commands: ['ingest', 'query'],
    versionCommands: ['sync', 'versions', 'day'],
  }));
  process.exit(0);
}
if (action === 'ingest') {
  const records = JSON.parse(await readFile(positional[0] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: positional[0] }), null, 2));
} else if (action === 'sync') {
  if (!positional[0]) throw new Error('sync requires a local source URL');
  const result = await service.ingestSource(new SourceClient(positional[0]), options.path ?? entryPath);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
} else if (action === 'versions') {
  console.log(JSON.stringify(await readVersionHistory(service.repository, {
    route: options.route,
    direction: options.direction,
    serviceDate: options.date,
    asOf: options['as-of'],
  }), null, 2));
} else if (action === 'day') {
  const result = await readServiceDay(service.repository, {
    route: options.route,
    direction: options.direction,
    serviceDate: options.date,
    asOf: options['as-of'],
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'conflict') process.exitCode = 3;
} else {
  throw new Error('action must be ingest or query, sync, versions or day');
}
