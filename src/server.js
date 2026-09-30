import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getMaterials, getEquipment, getEvents, getReleases } from './db.js';
import { seed } from './seed.js';
import { derive, ValidationError, serializeBatches } from './derive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

// 常见致敏物类别（可在前端自行输入其它值）
export const ALLERGEN_OPTIONS = [
  '含麸质的谷物', '甲壳类', '鱼类', '蛋', '花生', '大豆', '乳', '坚果', '芹菜',
  '芥末', '芝麻', '二氧化硫及亚硫酸盐', '羽扇豆', '软体动物',
];

const db = openDb();
if (process.env.SEED !== '0') seed(db);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- 模型组装与重算 -----------------------------------------------------

function buildModel() {
  const materials = getMaterials(db);
  const equipment = getEquipment(db);
  const events = getEvents(db);
  return { materials, equipment, events };
}

function compute() {
  const model = buildModel();
  const { batches, equipmentResidue } = derive(model);
  return { model, batches, equipmentResidue };
}

// 更正事件后同步放行记录：快照过敏原与新结果不同（或批次消失）则失效。
function syncReleases(batches) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const stmt = db.prepare(
    `UPDATE releases SET status = 'invalid', invalid_reason = ?, invalidated_at = ?
     WHERE id = ? AND status = 'valid'`
  );
  for (const r of getReleases(db)) {
    if (r.status !== 'valid') continue;
    const b = batches.get(r.batch_no);
    const snapshot = JSON.parse(r.allergens_snapshot || '[]');
    if (!b) {
      stmt.run(`批次「${r.batch_no}」对应的加工事件已被删除，放行依据不存在`, now, r.id);
    } else if (JSON.stringify(snapshot) !== JSON.stringify(b.allergens)) {
      const from = snapshot.length ? snapshot.join('、') : '（无）';
      const to = b.allergens.length ? b.allergens.join('、') : '（无）';
      stmt.run(`早期事件更正后重算：过敏原集合由 [${from}] 变为 [${to}]，与放行时记录不一致`, now, r.id);
    }
  }
}

function statePayload() {
  const { model, batches, equipmentResidue } = compute();
  const residueOut = {};
  for (const [eqId, v] of equipmentResidue) residueOut[eqId] = v;
  return {
    materials: model.materials,
    equipment: model.equipment,
    events: model.events,
    batches: serializeBatches(batches),
    equipmentResidue: residueOut,
    releases: getReleases(db).map((r) => ({
      ...r,
      allergens_snapshot: JSON.parse(r.allergens_snapshot || '[]'),
    })),
    allergenOptions: ALLERGEN_OPTIONS,
  };
}

// ---- 基础校验工具 -------------------------------------------------------

const OCC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function badRequest(errors) {
  const err = new Error(Array.isArray(errors) ? errors.join('；') : errors);
  err.status = 400;
  err.details = Array.isArray(errors) ? errors : [errors];
  return err;
}

function parseAllergens(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、]/) : [];
  return [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))].sort();
}

function validateEventBody(body, { excludeId = null } = {}) {
  const errors = [];
  const kind = body.kind === 'clean' ? 'clean' : body.kind === 'process' ? 'process' : null;
  if (!kind) errors.push('事件类型必须是 process（加工）或 clean（清洗）');

  const equipmentId = Number(body.equipment_id);
  if (!Number.isInteger(equipmentId) || !db.prepare('SELECT 1 FROM equipment WHERE id=?').get(equipmentId)) {
    errors.push('请选择存在的设备');
  }

  const occAt = String(body.occ_at || '').trim();
  if (!OCC_RE.test(occAt)) errors.push('发生时间格式应为 YYYY-MM-DDTHH:MM');

  if (occAt && Number.isInteger(equipmentId)) {
    const clash = db
      .prepare('SELECT id FROM events WHERE equipment_id=? AND occ_at=? AND id IS NOT ?')
      .get(equipmentId, occAt, excludeId);
    if (clash) {
      const eqName = db.prepare('SELECT name FROM equipment WHERE id=?').get(equipmentId)?.name;
      errors.push(`设备「${eqName}」在 ${occAt} 已登记事件 #${clash.id}，同一设备事件时间不能冲突`);
    }
  }

  let batchNo = null;
  let verified = 0;
  let verifiedBy = null;
  const inputs = [];

  if (kind === 'process') {
    batchNo = String(body.batch_no || '').trim();
    if (!batchNo) errors.push('加工事件必须填写产出批次号');
    const dup = db
      .prepare('SELECT id FROM events WHERE batch_no = ? AND id IS NOT ?')
      .get(batchNo, excludeId);
    if (batchNo && dup) errors.push(`批次号「${batchNo}」已被事件 #${dup.id} 使用`);

    for (const [i, inp] of Array.isArray(body.inputs) ? body.inputs.entries() : []) {
      if (inp.kind === 'material') {
        const refId = Number(inp.ref_id);
        if (!Number.isInteger(refId) || !db.prepare('SELECT 1 FROM materials WHERE id=?').get(refId)) {
          errors.push(`输入 #${i + 1}：请选择存在的原料`);
          continue;
        }
        inputs.push({ kind: 'material', ref_id: refId, ref_batch_no: null, qty: String(inp.qty || '') });
      } else if (inp.kind === 'batch') {
        const refNo = String(inp.ref_batch_no || '').trim();
        if (!refNo) {
          errors.push(`输入 #${i + 1}：请填写引用的批次号`);
          continue;
        }
        inputs.push({ kind: 'batch', ref_id: null, ref_batch_no: refNo, qty: String(inp.qty || '') });
      } else {
        errors.push(`输入 #${i + 1}：类型必须是原料或批次`);
      }
    }
    if (kind && inputs.length === 0) errors.push('加工事件至少需要一个原料或前序批次输入');
  } else if (kind === 'clean') {
    verified = body.verified ? 1 : 0;
    verifiedBy = String(body.verified_by || '').trim();
    if (verified && !verifiedBy) errors.push('已核实清洗必须填写核实人');
  }

  if (errors.length) throw badRequest(errors);
  return {
    kind, equipmentId, occAt, batchNo, verified, verifiedBy,
    note: String(body.note || '').trim(), inputs,
  };
}

// ---- 路由 ---------------------------------------------------------------

app.get('/api/state', (req, res) => res.json(statePayload()));

// 原料
app.post('/api/materials', (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw badRequest('原料名称不能为空');
    const allergens = parseAllergens(req.body.allergens);
    const tx = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM materials WHERE name=?').get(name)) throw badRequest(`原料「${name}」已存在`);
      db.prepare('INSERT INTO materials (name, allergens) VALUES (?, ?)').run(name, JSON.stringify(allergens));
      syncReleases(derive(buildModel()).batches);
    });
    tx();
    res.status(201).json(statePayload());
  } catch (e) { next(e); }
});

app.put('/api/materials/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    if (!name) throw badRequest('原料名称不能为空');
    const allergens = parseAllergens(req.body.allergens);
    const tx = db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM materials WHERE id=?').get(id)) throw badRequest('原料不存在');
      if (db.prepare('SELECT 1 FROM materials WHERE name=? AND id<>?').get(name, id)) {
        throw badRequest(`原料「${name}」已存在`);
      }
      db.prepare('UPDATE materials SET name=?, allergens=? WHERE id=?').run(name, JSON.stringify(allergens), id);
      syncReleases(derive(buildModel()).batches);
    });
    tx();
    res.json(statePayload());
  } catch (e) { next(e); }
});

app.delete('/api/materials/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const tx = db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM materials WHERE id=?').get(id)) throw badRequest('原料不存在');
      const used = db.prepare('SELECT COUNT(*) c FROM event_inputs WHERE kind=\'material\' AND ref_id=?').get(id).c;
      if (used) throw badRequest(`该原料已被 ${used} 个事件引用，请先移除引用后再删除`);
      db.prepare('DELETE FROM materials WHERE id=?').run(id);
    });
    tx();
    res.json(statePayload());
  } catch (e) { next(e); }
});

// 设备
app.post('/api/equipment', (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw badRequest('设备名称不能为空');
    db.prepare('INSERT INTO equipment (name) VALUES (?)').run(name);
    res.status(201).json(statePayload());
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return next(badRequest('设备名称已存在'));
    next(e);
  }
});

app.delete('/api/equipment/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const tx = db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM equipment WHERE id=?').get(id)) throw badRequest('设备不存在');
      // 级联删除事件与输入，随后重算并使相关放行失效
      db.prepare('DELETE FROM events WHERE equipment_id=?').run(id);
      db.prepare('DELETE FROM equipment WHERE id=?').run(id);
      syncReleases(derive(buildModel()).batches);
    });
    tx();
    res.json(statePayload());
  } catch (e) { next(e); }
});

// 事件（加工 / 清洗）
const insertEvent = db.prepare(
  `INSERT INTO events (kind, equipment_id, occ_at, batch_no, verified, verified_by, note)
   VALUES (@kind, @equipmentId, @occAt, @batchNo, @verified, @verifiedBy, @note)`
);
const insertInput = db.prepare(
  'INSERT INTO event_inputs (event_id, kind, ref_id, ref_batch_no, qty, position) VALUES (?, ?, ?, ?, ?, ?)'
);

app.post('/api/events', (req, res, next) => {
  try {
    const v = validateEventBody(req.body);
    const tx = db.transaction(() => {
      const info = insertEvent.run(v);
      v.inputs.forEach((inp, i) =>
        insertInput.run(info.lastInsertRowid, inp.kind, inp.ref_id, inp.ref_batch_no, inp.qty, i)
      );
      // 事务内重算：违反"未来批次/循环/时间冲突"则抛错，整次提交回滚
      const { batches } = computeWithin();
      syncReleases(batches);
    });
    tx();
    res.status(201).json(statePayload());
  } catch (e) { next(e); }
});

app.put('/api/events/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const v = validateEventBody(req.body, { excludeId: id });
    const tx = db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM events WHERE id=?').get(id)) throw badRequest('事件不存在');
      db.prepare(
        `UPDATE events SET kind=@kind, equipment_id=@equipmentId, occ_at=@occAt,
           batch_no=@batchNo, verified=@verified, verified_by=@verifiedBy, note=@note WHERE id=@id`
      ).run({ ...v, id });
      db.prepare('DELETE FROM event_inputs WHERE event_id=?').run(id);
      v.inputs.forEach((inp, i) => insertInput.run(id, inp.kind, inp.ref_id, inp.ref_batch_no, inp.qty, i));
      const { batches } = computeWithin();
      syncReleases(batches);
    });
    tx();
    res.json(statePayload());
  } catch (e) { next(e); }
});

function computeWithin() {
  const model = buildModel();
  try {
    return derive(model);
  } catch (e) {
    if (e instanceof ValidationError) throw badRequest(e.errors);
    throw e;
  }
}

app.delete('/api/events/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const tx = db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM events WHERE id=?').get(id)) throw badRequest('事件不存在');
      db.prepare('DELETE FROM event_inputs WHERE event_id=?').run(id);
      db.prepare('DELETE FROM events WHERE id=?').run(id);
      // 删除后若留下悬空引用/循环，derive 会抛错 -> 回滚，整次提交拒绝
      const { batches } = computeWithin();
      syncReleases(batches);
    });
    tx();
    res.json(statePayload());
  } catch (e) { next(e); }
});

// 放行：以"当时"的推导结果登记，固化过敏原快照
app.post('/api/releases', (req, res, next) => {
  try {
    const batchNo = String(req.body.batch_no || '').trim();
    const releasedBy = String(req.body.released_by || '').trim();
    const note = String(req.body.note || '').trim();
    if (!batchNo) throw badRequest('请选择要放行的批次');
    if (!releasedBy) throw badRequest('请填写放行人');
    const { batches } = derive(buildModel());
    const b = batches.get(batchNo);
    if (!b) throw badRequest(`批次「${batchNo}」不存在，无法放行`);
    db.prepare(
      `INSERT INTO releases (event_id, batch_no, allergens_snapshot, released_by, note)
       VALUES (?, ?, ?, ?, ?)`
    ).run(b.eventId, batchNo, JSON.stringify(b.allergens), releasedBy, note);
    res.status(201).json(statePayload());
  } catch (e) {
    if (e instanceof ValidationError) return next(badRequest(e.errors));
    next(e);
  }
});

// ---- 错误处理 -----------------------------------------------------------

app.use((err, req, res, next) => {
  if (String(err.message || '').includes('UNIQUE constraint failed: events.equipment_id')) {
    return res.status(400).json({
      error: '同一设备在同一时刻已存在事件（时间冲突），整次提交被拒绝',
      details: ['同一设备事件时间冲突'],
    });
  }
  const status = err.status || (err instanceof ValidationError ? 400 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({
    error: err.message || '服务器内部错误',
    details: err.details || (err instanceof ValidationError ? err.errors : undefined),
  });
});

app.listen(PORT, HOST, () => {
  console.log(`过敏原换线追踪已启动：http://localhost:${PORT}`);
});
