import { schema } from './schema.js';

export function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${schema.entity} must be an object`);
  }
  const record = {
    sourceId: String(input.sourceId ?? '').trim(),
    source: String(input.source ?? '').trim(),
    observedAt: String(input.observedAt ?? '').trim(),
    label: String(input.label ?? '').trim(),
    attributes: input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes)
      ? structuredClone(input.attributes) : {},
  };
  for (const field of schema.required) {
    if (!record[field]) throw new Error(`missing ${field} for ${schema.entity}`);
  }
  if (!Number.isFinite(Date.parse(record.observedAt))) {
    throw new Error(`invalid observedAt for ${schema.entity}`);
  }
  return record;
}

function announcedRank(record) {
  const announced = Date.parse(record.attributes?.announcedAt ?? '');
  return Number.isFinite(announced) ? announced : null;
}

function observationRank(record) {
  const announced = announcedRank(record);
  return announced == null ? Date.parse(record.observedAt) : Math.max(announced, Date.parse(record.observedAt));
}

export function mergeRecords(existing, incoming) {
  const merged = new Map(existing.map((record) => [record.sourceId, record]));
  for (const record of incoming) {
    const current = merged.get(record.sourceId);
    if (!current) { merged.set(record.sourceId, record); continue; }
    const currentAnnounced = announcedRank(current);
    const incomingAnnounced = announcedRank(record);
    if (currentAnnounced != null && incomingAnnounced != null) {
      // An explicit announcement time orders versions. A replay of an older
      // announcement, including one served from a source cache after a newer
      // edition, must not overwrite the catalogue entry. Equal announcements
      // fall back to observation time so a re-fetch can still update details.
      if (incomingAnnounced > currentAnnounced
        || (incomingAnnounced === currentAnnounced && observationRank(record) >= observationRank(current))) {
        merged.set(record.sourceId, record);
      }
      continue;
    }
    if (currentAnnounced != null) continue;
    if (incomingAnnounced != null) { merged.set(record.sourceId, record); continue; }
    if (observationRank(record) >= observationRank(current)) merged.set(record.sourceId, record);
  }
  return [...merged.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

export function findRecords(records, { source, from, to } = {}) {
  return records.filter((record) => {
    if (source && record.source !== source) return false;
    const timestamp = Date.parse(record.observedAt);
    if (from && timestamp < Date.parse(from)) return false;
    if (to && timestamp > Date.parse(to)) return false;
    return true;
  });
}
