import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive, ValidationError } from '../src/derive.js';

const materials = (defs) =>
  defs.map(([id, name, allergens]) => ({ id, name, allergens }));

const equipment = (defs) => defs.map(([id, name]) => ({ id, name }));

let seq = 100;
const process = (over) => ({
  id: seq++,
  kind: 'process',
  equipment_id: 1,
  occ_at: '2026-09-30T10:00',
  batch_no: `B${seq}`,
  verified: 0,
  verified_by: null,
  inputs: [],
  ...over,
});
const clean = (over) => ({
  id: seq++,
  kind: 'clean',
  equipment_id: 1,
  occ_at: '2026-09-30T10:30',
  batch_no: null,
  verified: 1,
  verified_by: '质检',
  inputs: [],
  ...over,
});

const MAT = materials([
  [1, '面粉', ['含麸质的谷物']],
  [2, '牛奶', ['乳']],
  [3, '鸡蛋', ['蛋']],
  [4, '糖', []],
]);
const EQ = equipment([[1, 'A1'], [2, 'B1']]);

test('原料并集产出过敏原', () => {
  const e = process({ occ_at: '2026-09-30T08:00', batch_no: 'B1', inputs: [
    { kind: 'material', ref_id: 1 }, { kind: 'material', ref_id: 2 }, { kind: 'material', ref_id: 4 },
  ] });
  const { batches } = derive({ materials: MAT, equipment: EQ, events: [e] });
  assert.deepEqual(batches.get('B1').allergens, ['乳', '含麸质的谷物']);
});

test('设备残留带入后续批次，且残留路径可追溯到原料', () => {
  const e1 = process({ id: 1, occ_at: '2026-09-30T08:00', batch_no: 'B1', inputs: [{ kind: 'material', ref_id: 1 }] });
  const e2 = process({ id: 2, occ_at: '2026-09-30T09:00', batch_no: 'B2', inputs: [{ kind: 'material', ref_id: 2 }] });
  const { batches, equipmentResidue } = derive({ materials: MAT, equipment: EQ, events: [e1, e2] });
  // B2：牛奶 + A1 上 B1 留下的麸质残留
  assert.deepEqual(batches.get('B2').allergens, ['乳', '含麸质的谷物']);
  const residuePath = batches.get('B2').pathNodes.find((p) => p.allergen === '含麸质的谷物');
  assert.equal(residuePath.nodes[0].label, 'B2'); // 根=当前批次
  assert.equal(residuePath.nodes[1].kind, 'residue');
  assert.equal(residuePath.nodes.at(-1).label, '面粉');
  assert.deepEqual(equipmentResidue.get(1).allergens, ['乳', '含麸质的谷物']);
});

test('未核实清洗不清空残留，已核实清洗清空', () => {
  const e1 = process({ id: 1, occ_at: '2026-09-30T08:00', batch_no: 'B1', inputs: [{ kind: 'material', ref_id: 1 }] });
  const cUnverified = clean({ id: 2, occ_at: '2026-09-30T08:30', verified: 0, verified_by: null });
  const e2 = process({ id: 3, occ_at: '2026-09-30T09:00', batch_no: 'B2', inputs: [{ kind: 'material', ref_id: 4 }] });
  let r = derive({ materials: MAT, equipment: EQ, events: [e1, cUnverified, e2] });
  assert.deepEqual(r.batches.get('B2').allergens, ['含麸质的谷物']);

  const cVerified = clean({ id: 4, occ_at: '2026-09-30T08:45', verified: 1, verified_by: '李质检' });
  r = derive({ materials: MAT, equipment: EQ, events: [e1, cUnverified, cVerified, e2] });
  assert.deepEqual(r.batches.get('B2').allergens, []);
  assert.deepEqual(r.equipmentResidue.get(1).allergens, []);
});

test('引用前序批次得到传递并集', () => {
  const e1 = process({ id: 1, occ_at: '2026-09-30T08:00', batch_no: 'B1', inputs: [{ kind: 'material', ref_id: 1 }] });
  const c = clean({ id: 2, occ_at: '2026-09-30T08:30' });
  const e2 = process({ id: 3, occ_at: '2026-09-30T09:00', batch_no: 'B2', inputs: [{ kind: 'material', ref_id: 2 }, { kind: 'batch', ref_batch_no: 'B1' }] });
  const { batches } = derive({ materials: MAT, equipment: EQ, events: [e1, c, e2] });
  assert.deepEqual(batches.get('B2').allergens, ['乳', '含麸质的谷物']);
  const viaBatch = batches.get('B2').pathNodes.find((p) => p.allergen === '含麸质的谷物');
  assert.deepEqual(viaBatch.nodes.map((n) => n.kind), ['batch', 'batch', 'material']);
});

test('引用未来批次被拒绝（整次提交）', () => {
  const future = process({ id: 1, occ_at: '2026-09-30T12:00', batch_no: 'B2', inputs: [{ kind: 'material', ref_id: 4 }] });
  const now = process({ id: 2, occ_at: '2026-09-30T10:00', batch_no: 'B1', inputs: [{ kind: 'batch', ref_batch_no: 'B2' }] });
  assert.throws(() => derive({ materials: MAT, equipment: EQ, events: [future, now] }), (e) => {
    assert.ok(e instanceof ValidationError);
    assert.match(e.errors[0], /未来/);
    return true;
  });
});

test('循环引用被拒绝', () => {
  const a = process({ id: 1, occ_at: '2026-09-30T08:00', batch_no: 'A', inputs: [{ kind: 'batch', ref_batch_no: 'C' }] });
  const b = process({ id: 2, occ_at: '2026-09-30T09:00', batch_no: 'B', inputs: [{ kind: 'batch', ref_batch_no: 'A' }] });
  const c = process({ id: 3, occ_at: '2026-09-30T10:00', batch_no: 'C', inputs: [{ kind: 'batch', ref_batch_no: 'B' }, { kind: 'material', ref_id: 4 }] });
  assert.throws(() => derive({ materials: MAT, equipment: EQ, events: [a, b, c] }), (e) => {
    assert.ok(e instanceof ValidationError);
    assert.ok(e.errors.some((m) => m.includes('循环')));
    return true;
  });
});

test('同一设备同一时刻事件冲突被拒绝，不同设备允许', () => {
  const e1 = process({ id: 1, equipment_id: 1, occ_at: '2026-09-30T10:00', batch_no: 'B1', inputs: [{ kind: 'material', ref_id: 4 }] });
  const e2 = clean({ id: 2, equipment_id: 1, occ_at: '2026-09-30T10:00', verified: 0, verified_by: null });
  assert.throws(() => derive({ materials: MAT, equipment: EQ, events: [e1, e2] }), /时间冲突/);

  const e3 = process({ id: 3, equipment_id: 2, occ_at: '2026-09-30T10:00', batch_no: 'B3', inputs: [{ kind: 'material', ref_id: 4 }] });
  assert.doesNotThrow(() => derive({ materials: MAT, equipment: EQ, events: [e1, e3] }));
});

test('更正早期事件后，后续批次与残留重算', () => {
  const e1 = process({ id: 1, occ_at: '2026-09-30T08:00', batch_no: 'B1', inputs: [{ kind: 'material', ref_id: 1 }] });
  const e2 = process({ id: 2, occ_at: '2026-09-30T09:00', batch_no: 'B2', inputs: [{ kind: 'batch', ref_batch_no: 'B1' }] });
  let r = derive({ materials: MAT, equipment: EQ, events: [e1, e2] });
  assert.deepEqual(r.batches.get('B2').allergens, ['含麸质的谷物']);

  // 更正：B1 改用无过敏原的糖
  const e1Fixed = { ...e1, inputs: [{ kind: 'material', ref_id: 4 }] };
  r = derive({ materials: MAT, equipment: EQ, events: [e1Fixed, e2] });
  assert.deepEqual(r.batches.get('B1').allergens, []);
  assert.deepEqual(r.batches.get('B2').allergens, []);
  assert.deepEqual(r.equipmentResidue.get(1).allergens, []);
});

test('加工事件无输入被拒绝', () => {
  const e = process({ id: 1, batch_no: 'B1', inputs: [] });
  assert.throws(() => derive({ materials: MAT, equipment: EQ, events: [e] }), /至少需要一个/);
});

test('删除被引用的批次事件后留下悬空引用，整次拒绝', () => {
  const e1 = process({ id: 1, occ_at: '2026-09-30T08:00', batch_no: 'B1', inputs: [{ kind: 'material', ref_id: 1 }] });
  const e2 = process({ id: 2, occ_at: '2026-09-30T09:00', batch_no: 'B2', inputs: [{ kind: 'batch', ref_batch_no: 'B1' }] });
  // 模拟删除 e1 后剩余事件集合
  assert.throws(() => derive({ materials: MAT, equipment: EQ, events: [e2] }), /不存在的批次/);
});

test('不同设备的残留互不影响', () => {
  const onA = process({ id: 1, equipment_id: 1, occ_at: '2026-09-30T08:00', batch_no: 'A1b', inputs: [{ kind: 'material', ref_id: 1 }] });
  const onB = process({ id: 2, equipment_id: 2, occ_at: '2026-09-30T09:00', batch_no: 'B1b', inputs: [{ kind: 'material', ref_id: 4 }] });
  const r = derive({ materials: MAT, equipment: EQ, events: [onA, onB] });
  assert.deepEqual(r.batches.get('B1b').allergens, []);
  assert.deepEqual(r.equipmentResidue.get(2).allergens, []);
  assert.deepEqual(r.equipmentResidue.get(1).allergens, ['含麸质的谷物']);
});

test('批次号重复被拒绝', () => {
  const e1 = process({ id: 1, occ_at: '2026-09-30T08:00', batch_no: 'DUP', inputs: [{ kind: 'material', ref_id: 4 }] });
  const e2 = process({ id: 2, equipment_id: 2, occ_at: '2026-09-30T09:00', batch_no: 'DUP', inputs: [{ kind: 'material', ref_id: 4 }] });
  assert.throws(() => derive({ materials: MAT, equipment: EQ, events: [e1, e2] }), /必须唯一/);
});
