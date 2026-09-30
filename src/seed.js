// 空数据库时写入演示数据。设置 SEED=0 可跳过（仅初始化空表）。

export function seed(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM materials').get().c;
  if (count > 0) return false;

  const insMat = db.prepare('INSERT INTO materials (id, name, allergens) VALUES (?, ?, ?)');
  const insEq = db.prepare('INSERT INTO equipment (id, name) VALUES (?, ?)');
  const insEv = db.prepare(
    `INSERT INTO events (id, kind, equipment_id, occ_at, batch_no, verified, verified_by, note)
     VALUES (@id, @kind, @equipment_id, @occ_at, @batch_no, @verified, @verified_by, @note)`
  );
  const insInp = db.prepare(
    'INSERT INTO event_inputs (event_id, kind, ref_id, ref_batch_no, qty, position) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    // 原料（含 GB/T 23779 常见致敏物类别）
    insMat.run(1, '小麦面粉', JSON.stringify(['含麸质的谷物']));
    insMat.run(2, '全脂牛奶', JSON.stringify(['乳']));
    insMat.run(3, '大豆油', JSON.stringify(['大豆']));
    insMat.run(4, '白砂糖', JSON.stringify([]));
    insMat.run(5, '鸡蛋液', JSON.stringify(['蛋']));
    insMat.run(6, '可可粉', JSON.stringify([]));

    // 设备
    insEq.run(1, '搅拌线 A1');
    insEq.run(2, '烘烤线 B1');

    // 08:00 A1 搅拌含小麦的面团 -> B-1001（残留：含麸质的谷物）
    insEv.run({ id: 1, kind: 'process', equipment_id: 1, occ_at: '2026-09-30T08:00', batch_no: 'B-1001', verified: 0, verified_by: null, note: '小麦面团' });
    insInp.run(1, 'material', 1, null, '100kg', 0);
    insInp.run(1, 'material', 4, null, '5kg', 1);

    // 09:30 A1 未做已核实清洗，换产奶味配料 -> B-1002 应携带 含麸质的谷物（残留）+ 乳
    insEv.run({ id: 2, kind: 'process', equipment_id: 1, occ_at: '2026-09-30T09:30', batch_no: 'B-1002', verified: 0, verified_by: null, note: '换线，仅简单冲洗（未核实）' });
    insInp.run(2, 'material', 2, null, '60kg', 0);
    insInp.run(2, 'material', 4, null, '4kg', 1);

    // 11:00 A1 已核实清洗 -> 清空残留
    insEv.run({ id: 3, kind: 'clean', equipment_id: 1, occ_at: '2026-09-30T11:00', batch_no: null, verified: 1, verified_by: '李质检', note: 'CIP 清洗后 ATP 检测合格' });

    // 13:00 A1 清洗后用 B-1002 与鸡蛋生产 -> B-1003
    // 过敏原只来自输入并集：乳、含麸质的谷物（来自前序批次）、蛋；设备无残留
    insEv.run({ id: 4, kind: 'process', equipment_id: 1, occ_at: '2026-09-30T13:00', batch_no: 'B-1003', verified: 0, verified_by: null, note: '复配糕点馅' });
    insInp.run(4, 'batch', null, 'B-1002', '30kg', 0);
    insInp.run(4, 'material', 5, null, '20kg', 1);

    // 15:00 B1 烘烤线用大豆油 -> B-1004（另一台设备，互不影响）
    insEv.run({ id: 5, kind: 'process', equipment_id: 2, occ_at: '2026-09-30T15:00', batch_no: 'B-1004', verified: 0, verified_by: null, note: '巧克力烘烤' });
    insInp.run(5, 'material', 6, null, '40kg', 0);
    insInp.run(5, 'material', 3, null, '10kg', 1);
  });
  tx();
  return true;
}
