export const entryPath = "/timetables?route=R8";

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  const items = payload.items;
  const next = payload.next ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["editionId"]),
    source: "公交时刻表目录",
    observedAt: item["announcedAt"],
    label: String(item["route"]),
    attributes: structuredClone(item),
  })) };
}
