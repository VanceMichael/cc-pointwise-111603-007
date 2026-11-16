export const schema = Object.freeze({
  "product": "公交时刻表目录",
  "entity": "班次计划",
  "identity": "sourceId",
  "required": [
    "sourceId",
    "source",
    "observedAt",
    "label"
  ],
  "description": "公交时刻表变更的生效窗口"
});
