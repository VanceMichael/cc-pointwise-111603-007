import { listEditions, resolveServiceDay } from './timetable.js';

const fields = ["editionId", "route", "direction", "announcedAt", "validFrom", "validTo", "timezone", "departures"];

function row(record) {
  return {
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  };
}

/**
 * Business read entry point.
 *
 * Without a query it returns the retained catalogue rows, as before. With a
 * route, direction and service date it adds the edition in force and the
 * explanation for that choice (`serviceDay`). A conflict is reported as a
 * conflict and carries no `departures`; callers must not merge the candidates.
 */
export async function readOperations(repository, { route, direction, serviceDate, date, asOf } = {}) {
  const records = await repository.read();
  const result = { product: "公交时刻表目录", rows: records.map(row) };
  const requestedDate = serviceDate ?? date;
  if (route != null || direction != null || requestedDate != null) {
    if (route == null || direction == null || requestedDate == null) {
      throw new Error('service-day query requires route, direction and serviceDate');
    }
    result.serviceDay = resolveServiceDay(records, {
      route, direction, serviceDate: requestedDate, asOf,
    });
  }
  return result;
}

/** Edition in force for one route, direction and service day. */
export async function readServiceDay(repository, query) {
  const records = await repository.read();
  return { product: "公交时刻表目录", ...resolveServiceDay(records, query) };
}

/** Version history for a route/direction, optionally annotated for a service day. */
export async function readVersionHistory(repository, query) {
  const records = await repository.read();
  return { product: "公交时刻表目录", ...listEditions(records, query) };
}
