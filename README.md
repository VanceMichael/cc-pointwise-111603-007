# 公交时刻表目录

Node.js 本地数据接入项目。已有来源读取、结构化导入与业务查询，来源服务和业务存储独立。采集按版本管理：同一线路/方向可保留多个公告版本及其公布时间、服务日有效期，业务查询按服务日解析应使用的班次，而不是把最近抓到的公告当作立即生效。来源临时不可读不会删除现行计划。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行行为与本地接口测试；`npm run demo` 启动临时来源、导入首批与未来公告，展示今日与下周分别使用的版本，结束时自动关闭监听并清理临时数据，通常两秒内完成。`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`。演示数据不访问生产站点。

版本命令：

- `npm start -- sync http://127.0.0.1:<port>` 读取本地来源并合并版本；读取失败返回非零退出码且不改动本地计划。
- `npm start -- versions --route R8 --direction outbound [--date 2026-11-17]` 查看线路/方向版本列表，可按服务日标注当天所属版本。
- `npm start -- day --route R8 --direction outbound --date 2026-11-17 [--as-of <ISO 时间>]` 查询某服务日使用的版本、来源公布时间与有效期；冲突时退出码为 3 并列出冲突版本。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304、分页与条件请求。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析页面并保留原始来源属性，返回 records 和 next；`src/service.js` 以整批原子方式采集，跟随 next 分页，失败时保留既有版本；`src/repository.js` 维护持久集合；`src/timetable.js` 负责版本规范化、按线路/方向/服务日解析和冲突判定；`src/operations.js` 是读取该集合的业务消费入口，来源协议见 [CONTRACT.md](CONTRACT.md)。

状态目录属于运行产物。现有 CLI（ingest、query）和集合查询能力保持不变；版本状态复用同一持久集合，每条记录即一个来源版本。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。运行录制可用 test 和 demo，无需安装浏览器或外部数据库。

`npm start` 或 `npm start -- --help` 查看命令。`npm run acceptance` 在临时目录中验证本地来源读取、首批与未来公告导入、重启回读、旧缓存回流、来源失败保留、按服务日查询与版本历史，完成后清理临时状态。
