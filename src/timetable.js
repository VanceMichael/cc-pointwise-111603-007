import { schema } from './schema.js';

const SERVICE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseServiceDate(value, field = 'serviceDate') {
  if (typeof value !== 'string' || !SERVICE_DATE.test(value)) {
    throw new TypeError(`${field} must be a YYYY-MM-DD service date`);
  }
  const [, year, month, day] = value.match(SERVICE_DATE);
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)) {
    throw new Error(`${field} is not a calendar date`);
  }
  return value;
}

function requiredText(value, field, editionId) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error(editionId ? `missing ${field} for edition ${editionId}` : `missing ${field}`);
  }
  return text;
}

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

export function toEdition(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError(`${schema.entity} record must be an object`);
  }
  const attributes = record.attributes && typeof record.attributes === 'object'
    && !Array.isArray(record.attributes) ? record.attributes : {};
  const editionId = requiredText(attributes.editionId ?? record.sourceId, 'editionId', record.sourceId);
  const route = requiredText(attributes.route ?? record.label, 'route', editionId);
  const direction = requiredText(attributes.direction, 'direction', editionId);
  const validFrom = parseServiceDate(attributes.validFrom, `validFrom for ${editionId}`);
  const validTo = parseServiceDate(attributes.validTo, `validTo for ${editionId}`);
  if (validFrom > validTo) throw new Error(`validFrom is after validTo for edition ${editionId}`);
  const announcedAt = requiredText(attributes.announcedAt ?? record.observedAt,
    'announcedAt', editionId);
  if (!Number.isFinite(Date.parse(announcedAt))) {
    throw new Error(`invalid announcedAt for edition ${editionId}`);
  }
  return {
    editionId,
    sourceId: String(record.sourceId ?? editionId),
    source: String(record.source ?? ''),
    observedAt: String(record.observedAt ?? announcedAt),
    route,
    direction,
    announcedAt,
    announcedTime: Date.parse(announcedAt),
    validFrom,
    validTo,
    timezone: optionalText(attributes.timezone),
    replaces: optionalText(attributes.replaces),
    departures: structuredClone(attributes.departures ?? null),
    attributes: structuredClone(attributes),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const METADATA_FIELDS = new Set([
  'editionId', 'route', 'direction', 'announcedAt', 'validFrom', 'validTo',
  'replaces', 'source', 'observedAt', 'etag', 'lastModified', 'fetchedAt',
]);

export function timetableFingerprint(edition) {
  const plan = Object.fromEntries(Object.entries(edition.attributes)
    .filter(([field]) => !METADATA_FIELDS.has(field)));
  return stableValue(plan);
}

function collectEditions(records, { route, direction } = {}) {
  const editions = [];
  const invalid = [];
  for (const record of records) {
    const declaredRoute = record?.attributes?.route ?? record?.label;
    if (route != null && declaredRoute != null && String(declaredRoute) !== route) continue;
    const declaredDirection = record?.attributes?.direction;
    if (direction != null && declaredDirection != null && String(declaredDirection) !== direction) continue;
    let edition;
    try { edition = toEdition(record); } catch (error) {
      invalid.push({ sourceId: record?.sourceId ?? null, reason: error.message });
      continue;
    }
    if (route != null && edition.route !== route) continue;
    if (direction != null && edition.direction !== direction) continue;
    editions.push(edition);
  }
  return { editions, invalid };
}

export function editionView(edition, { selected = false } = {}) {
  return {
    sourceId: edition.sourceId,
    editionId: edition.editionId,
    source: edition.source,
    route: edition.route,
    direction: edition.direction,
    announcedAt: edition.announcedAt,
    observedAt: edition.observedAt,
    validFrom: edition.validFrom,
    validTo: edition.validTo,
    timezone: edition.timezone,
    replaces: edition.replaces,
    departures: structuredClone(edition.departures),
    selected,
  };
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function listEditions(records, { route, direction, serviceDate, date, asOf } = {}) {
  const requestedDate = serviceDate ?? date;
  const editionDate = requestedDate == null ? null : parseServiceDate(requestedDate);
  const { editions, invalid } = collectEditions(records, { route, direction });
  const resolution = route != null && direction != null && editionDate != null
    ? resolveServiceDay(records, { route, direction, serviceDate: editionDate, asOf })
    : null;
  const selectedId = resolution?.resolved ? resolution.editionId : null;
  const sorted = editions.sort((left, right) => (
    left.route.localeCompare(right.route)
    || left.direction.localeCompare(right.direction)
    || left.validFrom.localeCompare(right.validFrom)
    || left.announcedTime - right.announcedTime
    || left.editionId.localeCompare(right.editionId)
  ));
  return {
    versions: sorted.map((edition) => ({
      ...editionView(edition, { selected: edition.editionId === selectedId }),
      validOnDate: editionDate != null
        && edition.validFrom <= editionDate && editionDate <= edition.validTo,
    })),
    invalid,
    resolution,
  };
}

function precedenceEdges(editions) {
  const byId = new Map(editions.map((edition) => [edition.editionId, edition]));
  return new Map(editions.map((edition) => {
    const target = edition.replaces && byId.get(edition.replaces);
    // A replacement announced before the edition it claims to replace is not
    // a reliable precedence statement; leave both editions competing.
    const trusted = target && target.editionId !== edition.editionId
      && edition.announcedTime >= target.announcedTime;
    return [edition.editionId, trusted ? [target.editionId] : []];
  }));
}

function replacementCycle(editions) {
  const byId = new Map(editions.map((edition) => [edition.editionId, edition]));
  // Cycle detection considers every declared replacement, even an
  // announcement that predates its target: a cycle is contradictory on its
  // face and must be surfaced rather than silently ordered by document time.
  const edges = new Map(editions.map((edition) => [edition.editionId,
    edition.replaces && byId.has(edition.replaces) && edition.replaces !== edition.editionId
      ? [edition.replaces] : []]));
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const target of edges.get(id) ?? []) {
      if (state.get(target) === 1) {
        return stack.slice(stack.indexOf(target));
      }
      if (!state.has(target)) {
        const cycle = visit(target);
        if (cycle) return cycle;
      }
    }
    state.set(id, 2);
    stack.pop();
    return null;
  };
  for (const edition of editions) {
    if (!state.has(edition.editionId)) {
      const cycle = visit(edition.editionId);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * All editions that participate in one precedence graph.
 *
 * Precedence may pass through editions that are not valid on the queried day:
 * a replacement of a replacement still supersedes the original within its own
 * window. Only candidates can be selected, so an expired intermediate edition
 * is never returned.
 */
function reachableEditions(start, editions) {
  const byId = new Map(editions.map((edition) => [edition.editionId, edition]));
  const seen = new Set(start.map((edition) => edition.editionId));
  const pending = [...seen];
  while (pending.length) {
    const edition = byId.get(pending.pop());
    if (edition?.replaces && byId.has(edition.replaces) && !seen.has(edition.replaces)) {
      seen.add(edition.replaces);
      pending.push(edition.replaces);
    }
  }
  return editions.filter((edition) => seen.has(edition.editionId));
}

/** Candidates not superseded by another candidate through the precedence graph. */
function maximalEditions(candidates, graph) {
  const direct = precedenceEdges(graph);
  const dominated = new Set();
  for (const edition of candidates) {
    const pending = [...(direct.get(edition.editionId) ?? [])];
    const seen = new Set();
    while (pending.length) {
      const target = pending.pop();
      if (seen.has(target)) continue;
      seen.add(target);
      dominated.add(target);
      pending.push(...(direct.get(target) ?? []));
    }
  }
  return candidates.filter((edition) => !dominated.has(edition.editionId));
}

function candidateViews(candidates, selected) {
  return [...candidates].sort((left, right) => (
    left.validFrom.localeCompare(right.validFrom)
    || left.announcedTime - right.announcedTime
    || left.editionId.localeCompare(right.editionId)
  )).map((edition) => editionView(edition, { selected: edition === selected }));
}

function emptyResolution(query, status, extra = {}) {
  return {
    query,
    status,
    resolved: false,
    editionId: null,
    sourceId: null,
    announcedAt: null,
    validFrom: null,
    validTo: null,
    timezone: null,
    replaces: null,
    departures: null,
    candidates: [],
    alternatives: [],
    conflictingEditions: [],
    conflict: null,
    ...extra,
  };
}

/**
 * Resolve the timetable edition for one route, direction and service day.
 *
 * Only editions whose inclusive [validFrom, validTo] interval contains the
 * service date are candidates. `replaces` establishes precedence among them,
 * and only candidates may be selected: an edition announced for a future
 * window cannot change today's table, and an expired intermediate edition is
 * never returned even though precedence can pass through it. An old cached
 * page cannot displace a newer edition in the catalogue at all.
 */
export function resolveServiceDay(records, {
  route, direction, serviceDate, date, asOf,
} = {}) {
  const requestedRoute = requiredText(route, 'route');
  const requestedDirection = requiredText(direction, 'direction');
  const requestedDate = parseServiceDate(serviceDate ?? date);
  const asOfTime = asOf == null ? null : Date.parse(asOf);
  if (asOf != null && !Number.isFinite(asOfTime)) throw new Error('asOf must be an ISO timestamp');
  const query = { route: requestedRoute, direction: requestedDirection, serviceDate: requestedDate,
    ...(asOf == null ? {} : { asOf }) };
  const { editions, invalid } = collectEditions(records, {
    route: requestedRoute, direction: requestedDirection,
  });
  const candidates = editions
    .filter((edition) => edition.validFrom <= requestedDate && requestedDate <= edition.validTo)
    .filter((edition) => asOfTime == null || edition.announcedTime <= asOfTime);
  if (!candidates.length) {
    return emptyResolution(query, 'no_service', { invalid });
  }

  // Precedence is evaluated only among editions that had been announced by
  // `asOf`; an announcement outside that view cannot order or contradict the
  // editions a dispatcher could have seen at the time.
  const visible = asOfTime == null
    ? editions : editions.filter((edition) => edition.announcedTime <= asOfTime);
  const graph = reachableEditions(candidates, visible);
  const cycle = replacementCycle(graph);
  if (cycle) {
    return emptyResolution(query, 'conflict', {
      invalid,
      candidates: candidateViews(candidates),
      conflictingEditions: uniqueSorted(cycle),
      conflict: { reason: 'replacement_cycle', editionIds: uniqueSorted(cycle) },
    });
  }

  const maximal = maximalEditions(candidates, graph);
  const fingerprints = new Set(maximal.map(timetableFingerprint));
  if (maximal.length > 1 && fingerprints.size > 1) {
    return emptyResolution(query, 'conflict', {
      invalid,
      candidates: candidateViews(candidates),
      conflictingEditions: uniqueSorted(maximal.map((edition) => edition.editionId)),
      conflict: {
        reason: 'unresolved_precedence',
        editionIds: uniqueSorted(maximal.map((edition) => edition.editionId)),
      },
    });
  }

  const selected = [...maximal].sort((left, right) => (
    right.announcedTime - left.announcedTime || left.editionId.localeCompare(right.editionId)
  ))[0];
  const alternatives = uniqueSorted(maximal
    .filter((edition) => edition !== selected)
    .map((edition) => edition.editionId));
  return {
    query,
    status: 'resolved',
    resolved: true,
    editionId: selected.editionId,
    sourceId: selected.sourceId,
    announcedAt: selected.announcedAt,
    validFrom: selected.validFrom,
    validTo: selected.validTo,
    timezone: selected.timezone,
    replaces: selected.replaces,
    departures: structuredClone(selected.departures),
    edition: editionView(selected, { selected: true }),
    candidates: candidateViews(candidates, selected),
    alternatives,
    conflictingEditions: [],
    conflict: null,
    invalid,
  };
}
