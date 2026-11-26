'use strict';

const MAX_CATALOG_ITEMS = 36;
const MEDIA_FIELDS = 'id idMal format season seasonYear startDate { year } title { romaji english native } synonyms genres';

function positiveId(value) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim())))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalized(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function hasExplicitHentaiGenre(genres) {
  return Array.isArray(genres) && genres.some(genre => normalized(typeof genre === 'string' ? genre : genre?.name) === 'hentai');
}

function catalogQueries(items) {
  if (!Array.isArray(items) || items.length > MAX_CATALOG_ITEMS) return { valid: false, requests: [] };
  const requests = new Map();
  for (const item of items) {
    if (item?.provider !== 'reanime' || typeof item.id !== 'string' ||
      !/^[\p{L}\p{N}._~-]{1,200}$/u.test(item.id) || item.mal_id !== `reanime:${item.id}` ||
      hasExplicitHentaiGenre(item.genres)) continue;
    const anilistId = positiveId(item.anilistId);
    const malId = positiveId(item.malId);
    const kind = anilistId ? 'id' : malId ? 'idMal' : null;
    const id = anilistId || malId;
    if (!kind) continue;
    const key = `${kind}:${id}`;
    if (!requests.has(key)) requests.set(key, { kind, id });
  }
  return { valid: true, requests: [...requests.values()] };
}

function buildQuery(requests) {
  const variables = {};
  const declarations = [];
  const fields = [];
  requests.forEach(({ kind, id }, index) => {
    const alias = `media${index}`;
    const variable = `${alias}Id`;
    variables[variable] = id;
    declarations.push(`$${variable}: Int`);
    fields.push(`${alias}: Media(${kind}: $${variable}, type: ANIME) { ${MEDIA_FIELDS} }`);
  });
  return { query: `query(${declarations.join(', ')}) { ${fields.join(' ')} }`, variables };
}

function toHentaiRecord(media) {
  if (!media || !hasExplicitHentaiGenre(media.genres)) return null;
  const anilistId = positiveId(media.id);
  const malId = positiveId(media.idMal);
  const year = positiveId(media.seasonYear) || positiveId(media.startDate?.year);
  const titles = [...new Set([
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    ...(Array.isArray(media.synonyms) ? media.synonyms : [])
  ].filter(value => typeof value === 'string').map(value => value.trim()).filter(value => value && value.length <= 300))].slice(0, 32);
  if ((!anilistId && !malId) || !year || !titles.length) return null;
  return {
    source: 'AniList GraphQL',
    status: 'CONFIRMED_HENTAI',
    anilistId,
    malId,
    year,
    format: typeof media.format === 'string' ? media.format : '',
    season: typeof media.season === 'string' ? media.season : '',
    titles,
    evidence: { field: 'genres', value: 'Hentai' }
  };
}

async function lookupAdultCatalogMetadata(items, requestGraphql) {
  if (typeof requestGraphql !== 'function') return { available: false, requested: 0, records: [] };
  const catalog = catalogQueries(items);
  if (!catalog.valid) return { available: false, requested: 0, records: [] };
  if (!catalog.requests.length) return { available: true, requested: 0, records: [] };

  const { query, variables } = buildQuery(catalog.requests);
  try {
    const data = await requestGraphql(query, variables, { maxWait: 8000 });
    if (!data || typeof data !== 'object' || catalog.requests.some((_, index) => !Object.hasOwn(data, `media${index}`))) {
      return { available: false, requested: catalog.requests.length, records: [] };
    }
    const records = catalog.requests.map((_, index) => toHentaiRecord(data[`media${index}`])).filter(Boolean);
    return { available: true, requested: catalog.requests.length, records };
  } catch {
    return { available: false, requested: catalog.requests.length, records: [] };
  }
}

module.exports = {
  MAX_CATALOG_ITEMS,
  catalogQueries,
  buildQuery,
  hasExplicitHentaiGenre,
  lookupAdultCatalogMetadata,
  toHentaiRecord
};
