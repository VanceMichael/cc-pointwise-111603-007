# 来源与消费契约

## 来源

入口 `/timetables?route=R8`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening、updated、cache、conflict、paged 是可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

announcedAt 为公布时间，validFrom/validTo 为线路所在地服务日的闭区间。replaces 只在新版本的有效区间内替代旧表，未来公告不能立即使今日班次失效。来源缓存可在新版本后返回旧表；查询服务日而非抓取日决定班次。

采集以整批为原子操作：多页 next 全部读取并校验后才写入，任一次读取失败、超时、断开或页面格式错误都不会删除或覆盖既有版本。旧缓存回流按来源身份合并，较旧的公告不能覆盖较新的公告；保留的多个观察都参与服务日解析。

## 版本解析

版本以 `(route, direction)` 分组，按 `editionId` 识别，保留 `announcedAt` 与 `[validFrom, validTo]` 服务日闭区间。

查询某线路、方向、服务日时：

1. 只有区间包含该服务日的版本参与解析；未来版本不影响今日，过期版本不参与当日。
2. 有效版本之间按 `replaces` 建立优先关系，且仅在替代版本自身有效时生效；关系可传递。
3. 若有效版本中存在替代环，或存在多个互不替代、班次内容不同的最大版本，则返回 `status: "conflict"`，`departures` 与 `editionId` 为 null，并列出 `conflictingEditions`。不得把候选班次拼接成一张表。
4. 内容相同（除公告元数据外）的最大版本不构成冲突，取最近公布者并列出 `alternatives`。
5. 没有有效版本时返回 `status: "no_service"`。

`asOf` 可把解析限定为某时刻之前已公布的版本，用于复盘“当时能看到哪一版”。

## 业务消费

`readOperations(repository)` 保持返回 product 和 rows，每行带 sourceId/source/observedAt/attributes，用于现有本地运维和兼容查询。传入 `{route, direction, serviceDate}` 时额外返回 `serviceDay`，其中包含所选 `editionId`、`announcedAt`、有效期、候选版本和选择原因；冲突时同样不返回班次。

`readServiceDay(repository, query)` 直接返回某服务日的解析结果；`readVersionHistory(repository, query)` 返回线路/方向的版本列表，可按服务日标注 `validOnDate` 与 `selected`，并附带同一份 `resolution` 供值班核对。

原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
