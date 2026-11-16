# 来源与消费契约

## 来源

入口 `/timetables?route=R8`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

announcedAt 为公布时间，validFrom/validTo 为线路所在地服务日的闭区间。replaces 只在新版本的有效区间内替代旧表，未来公告不能立即使今日班次失效。来源缓存可在新版本后返回旧表；查询服务日而非抓取日决定班次。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
