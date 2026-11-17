import { findRecords, mergeRecords, normalizeRecord } from './records.js';
import { entryPath, parsePage } from './adapter.js';

export class CollectionService {
  constructor(repository) { this.repository = repository; }

  async ingest(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError('ingest input must be an array');
    const accepted = inputs.map(normalizeRecord);
    const current = await this.repository.read();
    const merged = mergeRecords(current, accepted);
    await this.repository.replace(merged);
    return { accepted: accepted.length, stored: merged.length };
  }

  async query(filters) { return findRecords(await this.repository.read(), filters); }

  /**
   * Read a source listing (following `next` pages) and merge its editions into
   * the local catalogue.
   *
   * A failed read, malformed page or timeout is an observation failure, not a
   * withdrawal: the previous editions stay untouched and no partial page batch
   * is saved. Editions returned from a stale source cache are merged by
   * `mergeRecords`, which cannot replace a newer observation. All retained
   * observations remain available for date resolution.
   */
  async ingestSource(client, path = entryPath, { maxPages = 20 } = {}) {
    const current = await this.repository.read();
    const accepted = [];
    const visited = new Set();
    let next = path;
    let pages = 0;
    try {
      while (next != null && pages < maxPages) {
        if (visited.has(next)) throw new Error(`source page cycle: ${next}`);
        visited.add(next);
        const page = parsePage(await client.read(next));
        pages += 1;
        accepted.push(...page.records.map(normalizeRecord));
        next = page.next;
      }
      if (next != null) throw new Error(`source exceeded ${maxPages} pages`);
    } catch (error) {
      return {
        ok: false, accepted: 0, stored: current.length, pages, error: error.message,
      };
    }
    const merged = mergeRecords(current, accepted);
    await this.repository.replace(merged);
    return {
      ok: true, accepted: accepted.length, stored: merged.length, pages, next: null,
    };
  }

  async sync(client, path = entryPath) { return this.ingestSource(client, path); }
}
