import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('命令帮助列出导入和查询入口且正常退出', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--help'], {encoding: 'utf8'});
  assert.equal(result.status, 0);
  const help = JSON.parse(result.stdout);
  assert.ok(help.usage.includes('ingest'));
  assert.deepEqual(help.commands, ['ingest', 'query']);
  assert.ok(help.usage.includes('day'));
  assert.ok(help.usage.includes('versions'));
});

test('版本查询缺少参数时显式失败而不是猜测服务日', () => {
  const missingRoute = spawnSync(process.execPath, ['src/cli.js', 'day', '--direction', 'outbound', '--date', '2026-11-17'], {encoding: 'utf8'});
  assert.notEqual(missingRoute.status, 0);
  assert.match(missingRoute.stderr, /missing route/);
  const missingDate = spawnSync(process.execPath, ['src/cli.js', 'day', '--route', 'R8', '--direction', 'outbound'], {encoding: 'utf8'});
  assert.notEqual(missingDate.status, 0);
  assert.match(missingDate.stderr, /YYYY-MM-DD/);
});

test('未知动作明确失败而不执行默认查询', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'invalid-action'], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ingest or query/);
});
