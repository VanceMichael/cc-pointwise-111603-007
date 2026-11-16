const fields = ["editionId", "route", "direction", "announcedAt", "validFrom", "validTo", "timezone", "departures"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "公交时刻表目录", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
