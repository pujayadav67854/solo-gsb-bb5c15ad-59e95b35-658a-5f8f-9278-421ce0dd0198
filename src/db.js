import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'allergen.db');

export function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS materials (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    allergens  TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS equipment (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL CHECK (kind IN ('process','clean')),
    equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    occ_at       TEXT NOT NULL,                 -- 本地时间 'YYYY-MM-DDTHH:MM'
    batch_no     TEXT,                          -- 加工事件唯一
    verified     INTEGER NOT NULL DEFAULT 0,    -- 清洗是否已核实
    verified_by  TEXT,
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_time ON events(occ_at);

  -- 同一设备事件时间冲突由推导层给出带中文名的拒绝信息，
  -- 此唯一索引作为数据库侧的最后防线。
  CREATE UNIQUE INDEX IF NOT EXISTS ux_events_equipment_time
    ON events(equipment_id, occ_at);

  CREATE TABLE IF NOT EXISTS event_inputs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('material','batch')),
    ref_id        INTEGER,                      -- kind=material 时使用
    ref_batch_no  TEXT,                         -- kind=batch 时使用（按批次号引用）
    qty           TEXT NOT NULL DEFAULT '',
    position      INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_inputs_event ON event_inputs(event_id);

  -- 放行记录：登记时固化当时推导出的过敏原集合；
  -- 更正事件重算后集合不同或批次消失则置为 invalid 并记录原因。
  CREATE TABLE IF NOT EXISTS releases (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id           INTEGER,                 -- 不设外键：批次事件被删除时记录保留以留痕
    batch_no           TEXT NOT NULL,
    allergens_snapshot TEXT NOT NULL,           -- 登记时的过敏原 JSON 数组
    released_by        TEXT NOT NULL DEFAULT '',
    note               TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','invalid')),
    invalid_reason     TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    invalidated_at     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_releases_batch ON releases(batch_no);
  `);
}

// ---- 读取全量模型（供 derive 重算） -------------------------------------

export function getMaterials(db) {
  return db
    .prepare('SELECT id, name, allergens FROM materials ORDER BY id')
    .all()
    .map((m) => ({ ...m, allergens: JSON.parse(m.allergens || '[]') }));
}

export function getEquipment(db) {
  return db.prepare('SELECT id, name FROM equipment ORDER BY id').all();
}

export function getEvents(db) {
  const events = db
    .prepare('SELECT * FROM events ORDER BY occ_at, id')
    .all()
    .map((e) => ({ ...e, verified: !!e.verified }));
  const inputs = db
    .prepare('SELECT * FROM event_inputs ORDER BY event_id, position, id')
    .all();
  const byEvent = new Map();
  for (const inp of inputs) {
    if (!byEvent.has(inp.event_id)) byEvent.set(inp.event_id, []);
    byEvent.get(inp.event_id).push({
      kind: inp.kind,
      ref_id: inp.ref_id,
      ref_batch_no: inp.ref_batch_no,
      qty: inp.qty,
    });
  }
  return events.map((e) => ({ ...e, inputs: byEvent.get(e.id) || [] }));
}

export function getReleases(db) {
  return db.prepare('SELECT * FROM releases ORDER BY id DESC').all();
}
