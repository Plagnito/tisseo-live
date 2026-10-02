// Décodeur GTFS-Realtime (protobuf) — sans dépendance.
// ---------------------------------------------------------------
// Tisséo publie son flux en JSON ; presque tous les autres réseaux le
// publient au format binaire d'origine (protocol buffers). Plutôt que
// d'embarquer une bibliothèque protobuf pour trois messages, on lit le
// format à la main : c'est une suite de (numéro de champ, type de fil,
// valeur), et la spécification GTFS-RT tient en une trentaine de champs.
//
// Le résultat a EXACTEMENT la forme du JSON de Tisséo (noms en snake_case :
// entity[].trip_update.stop_time_update[].arrival.time…), de sorte que
// lib/core.mjs et lib/realtime.mjs le lisent sans rien savoir du format
// d'origine.
//
// Pur et testable : `node --test`.
// ---------------------------------------------------------------

const utf8 = new TextDecoder('utf-8');

// Lecteur de bas niveau sur un Uint8Array.
function reader(buf, start = 0, end = buf.length) {
  let pos = start;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // Entier à longueur variable. Les horodatages tiennent sur 53 bits : on
  // accumule en flottant plutôt qu'en BigInt (dix fois plus rapide, exact
  // jusqu'à 2^53).
  function varint() {
    let result = 0, mul = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= end) throw new RangeError('GTFS-RT tronqué (varint)');
      const b = buf[pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
    throw new RangeError('GTFS-RT invalide (varint trop long)');
  }
  return {
    get pos() { return pos; },
    more: () => pos < end,
    varint,
    // Entier signé encodé en varint « classique » (int32/int64) : une valeur
    // négative occupe dix octets et dépasse 2^63. Les retards négatifs
    // (« en avance ») passent par là.
    int() {
      const v = varint();
      return v >= 2 ** 63 ? v - 2 ** 64 : v;
    },
    float() { const v = view.getFloat32(pos, true); pos += 4; return v; },
    double() { const v = view.getFloat64(pos, true); pos += 8; return v; },
    bytes() {
      const len = varint();
      if (pos + len > end) throw new RangeError('GTFS-RT tronqué (champ)');
      const s = pos; pos += len;
      return [s, pos];
    },
    string() {
      const len = varint();
      if (pos + len > end) throw new RangeError('GTFS-RT tronqué (texte)');
      const s = utf8.decode(buf.subarray(pos, pos + len)); pos += len;
      return s;
    },
    skip(wire) {
      if (wire === 0) varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) { const len = varint(); pos += len; }
      else if (wire === 5) pos += 4;
      else throw new RangeError(`GTFS-RT invalide (type de fil ${wire})`);
      if (pos > end) throw new RangeError('GTFS-RT tronqué');
    },
  };
}

// Un message = { numéro de champ : [nom, lecteur, répété ?] }. `lecteur` est
// soit le nom d'un type scalaire, soit la description d'un sous-message.
const TRANSLATED = { 1: ['translation', { 1: ['text', 'string'], 2: ['language', 'string'] }, true] };
const TRIP = {
  1: ['trip_id', 'string'], 2: ['start_time', 'string'], 3: ['start_date', 'string'],
  4: ['schedule_relationship', 'enum'], 5: ['route_id', 'string'], 6: ['direction_id', 'uint'],
};
const VEHICLE = { 1: ['id', 'string'], 2: ['label', 'string'], 3: ['license_plate', 'string'] };
const EVENT = { 1: ['delay', 'int'], 2: ['time', 'int'], 3: ['uncertainty', 'int'] };
const STOP_TIME = {
  1: ['stop_sequence', 'uint'], 2: ['arrival', EVENT], 3: ['departure', EVENT],
  4: ['stop_id', 'string'], 5: ['schedule_relationship', 'enum'],
};
const TRIP_UPDATE = {
  1: ['trip', TRIP], 2: ['stop_time_update', STOP_TIME, true], 3: ['vehicle', VEHICLE],
  4: ['timestamp', 'uint'], 5: ['delay', 'int'],
};
const POSITION = {
  1: ['latitude', 'float'], 2: ['longitude', 'float'], 3: ['bearing', 'float'],
  4: ['odometer', 'double'], 5: ['speed', 'float'],
};
const VEHICLE_POSITION = {
  1: ['trip', TRIP], 2: ['position', POSITION], 3: ['current_stop_sequence', 'uint'],
  4: ['current_status', 'enum'], 5: ['timestamp', 'uint'], 6: ['congestion_level', 'enum'],
  7: ['stop_id', 'string'], 8: ['vehicle', VEHICLE], 9: ['occupancy_status', 'enum'],
};
const ALERT = {
  1: ['active_period', { 1: ['start', 'uint'], 2: ['end', 'uint'] }, true],
  5: ['informed_entity', {
    1: ['agency_id', 'string'], 2: ['route_id', 'string'], 3: ['route_type', 'int'],
    4: ['trip', TRIP], 5: ['stop_id', 'string'],
  }, true],
  6: ['cause', 'enum'], 7: ['effect', 'enum'], 8: ['url', TRANSLATED],
  10: ['header_text', TRANSLATED], 11: ['description_text', TRANSLATED], 14: ['severity_level', 'enum'],
};
const ENTITY = {
  1: ['id', 'string'], 2: ['is_deleted', 'bool'], 3: ['trip_update', TRIP_UPDATE],
  4: ['vehicle', VEHICLE_POSITION], 5: ['alert', ALERT],
};
const FEED = {
  1: ['header', { 1: ['gtfs_realtime_version', 'string'], 2: ['incrementality', 'enum'], 3: ['timestamp', 'uint'] }],
  2: ['entity', ENTITY, true],
};

function message(buf, start, end, schema) {
  const r = reader(buf, start, end);
  const out = {};
  while (r.more()) {
    const tag = r.varint();
    const field = Math.floor(tag / 8), wire = tag & 7;
    const def = schema[field];
    if (!def) { r.skip(wire); continue; }
    const [name, type, repeated] = def;
    let value;
    if (typeof type === 'object') {
      if (wire !== 2) { r.skip(wire); continue; }
      const [s, e] = r.bytes();
      value = message(buf, s, e, type);
    } else if (type === 'string') {
      if (wire !== 2) { r.skip(wire); continue; }
      value = r.string();
    } else if (type === 'float') {
      if (wire !== 5) { r.skip(wire); continue; }
      value = r.float();
    } else if (type === 'double') {
      if (wire !== 1) { r.skip(wire); continue; }
      value = r.double();
    } else {
      if (wire !== 0) { r.skip(wire); continue; }
      value = type === 'int' ? r.int() : type === 'bool' ? r.varint() !== 0 : r.varint();
    }
    if (repeated) (out[name] ??= []).push(value);
    else out[name] = value;
  }
  return out;
}

// Octets d'un flux GTFS-RT → objet de même forme que le JSON de Tisséo.
export function decodeGtfsRt(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!buf.length) throw new RangeError('GTFS-RT vide');
  const feed = message(buf, 0, buf.length, FEED);
  if (!feed.header) throw new RangeError('GTFS-RT sans en-tête');
  feed.entity ??= [];
  return feed;
}

// Ce qu'un flux contient réellement. Le catalogue national annonce des
// « features », mais pas toujours (Grenoble : liste vide) et pas toujours
// justes : on regarde.
export function feedKinds(feed) {
  const kinds = { trip_updates: 0, vehicle_positions: 0, alerts: 0 };
  for (const e of feed?.entity ?? []) {
    if (e.trip_update) kinds.trip_updates++;
    if (e.vehicle) kinds.vehicle_positions++;
    if (e.alert) kinds.alerts++;
  }
  return kinds;
}

// Plusieurs flux d'un même réseau (positions, horaires, alertes sont souvent
// publiés à trois adresses) → un seul objet. L'horodatage retenu est le plus
// récent : c'est lui qui sert d'« instant du flux ».
export function mergeFeeds(feeds) {
  const list = feeds.filter(Boolean);
  if (!list.length) return null;
  let timestamp = 0;
  const entity = [];
  for (const f of list) {
    timestamp = Math.max(timestamp, Number(f.header?.timestamp) || 0);
    for (const e of f.entity ?? []) entity.push(e);
  }
  return { header: { ...list[0].header, timestamp }, entity };
}
