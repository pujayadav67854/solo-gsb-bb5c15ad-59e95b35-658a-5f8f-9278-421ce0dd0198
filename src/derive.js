// 核心纯逻辑：校验 + 按时间重算批次过敏原并集、设备残留与来源路径。
// 该模块不接触数据库，事件的写入/更正/删除均以全量事件重跑此函数为唯一推导来源。

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('；'));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

const SORTED = (arr) => [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))].sort();

const node = (kind, id, label, allergens, happenedAt = null) => ({
  kind, // 'material' | 'batch' | 'residue' | 'clean'
  id,
  label,
  allergens,
  happenedAt,
});

const pathKey = (p) => `${p.allergen}|${p.nodes.map((n) => `${n.kind}:${n.id}`).join('>')}`;

/**
 * @param {object} data
 * @param {{id:number,name:string,allergens:string[]}[]} data.materials
 * @param {{id:number,name:string}[]} data.equipment
 * @param {object[]} data.events  加工/清洗事件（含 inputs）
 * @returns {{batches:Map, equipmentResidue:Map, orderedEvents:object[]}}
 * 校验失败时抛 ValidationError（收集全部错误，整次提交拒绝）。
 */
export function derive(data) {
  const { materials, equipment, events } = data;
  const errors = [];

  const materialById = new Map(materials.map((m) => [m.id, m]));
  const equipmentById = new Map(equipment.map((e) => [e.id, e]));

  // ---- 结构校验 ----------------------------------------------------------
  const seenBatchNo = new Map(); // batch_no -> eventId
  const eventIds = new Set();

  for (const ev of events) {
    if (eventIds.has(ev.id)) errors.push(`事件 #${ev.id} 重复`);
    eventIds.add(ev.id);

    if (!ev.occ_at) {
      errors.push(`事件 #${ev.id} 缺少发生时间`);
    }
    if (!equipmentById.has(ev.equipment_id)) {
      errors.push(`事件 #${ev.id} 引用了不存在的设备 #${ev.equipment_id}`);
    }

    if (ev.kind === 'process') {
      if (!ev.batch_no || !String(ev.batch_no).trim()) {
        errors.push(`事件 #${ev.id}（加工）缺少产出批次号`);
      } else if (seenBatchNo.has(ev.batch_no)) {
        errors.push(
          `批次号「${ev.batch_no}」同时由事件 #${seenBatchNo.get(ev.batch_no)} 与事件 #${ev.id} 产出，必须唯一`
        );
      } else {
        seenBatchNo.set(ev.batch_no, ev.id);
      }
      if (!ev.inputs || ev.inputs.length === 0) {
        errors.push(`加工事件 #${ev.id}（批次 ${ev.batch_no ?? '?'}）至少需要一个原料或前序批次输入`);
      }
    } else if (ev.kind === 'clean') {
      if (ev.verified && !String(ev.verified_by ?? '').trim()) {
        errors.push(`清洗事件 #${ev.id} 标记为已核实但缺少核实人`);
      }
    } else {
      errors.push(`事件 #${ev.id} 类型非法（${ev.kind}）`);
    }
  }

  // ---- 同设备事件时间冲突（含清洗事件，同一时刻只允许一个） ---------------
  const conflictSeen = new Map(); // equipment|occ_at -> event
  for (const ev of events) {
    if (!ev.occ_at || !equipmentById.has(ev.equipment_id)) continue;
    const key = `${ev.equipment_id}|${ev.occ_at}`;
    const prev = conflictSeen.get(key);
    if (prev) {
      const eq = equipmentById.get(ev.equipment_id).name;
      errors.push(
        `设备「${eq}」在 ${ev.occ_at} 存在时间冲突：事件 #${prev.id} 与事件 #${ev.id} 不能占用同一时刻`
      );
    } else {
      conflictSeen.set(key, ev);
    }
  }

  // ---- 输入引用校验 ------------------------------------------------------
  const eventByBatchNo = new Map();
  for (const ev of events) {
    if (ev.kind === 'process') eventByBatchNo.set(ev.batch_no, ev);
  }

  for (const ev of events) {
    if (ev.kind !== 'process') continue;
    for (const inp of ev.inputs ?? []) {
      if (inp.kind === 'material') {
        if (!materialById.has(inp.ref_id)) {
          errors.push(`事件 #${ev.id} 引用了不存在的原料 #${inp.ref_id}`);
        }
      } else if (inp.kind === 'batch') {
        const src = eventByBatchNo.get(inp.ref_batch_no);
        if (!src) {
          errors.push(`事件 #${ev.id} 引用了不存在的批次「${inp.ref_batch_no}」`);
        } else if (src.id === ev.id) {
          errors.push(`事件 #${ev.id} 的批次「${ev.batch_no}」不能引用自身`);
        }
      } else {
        errors.push(`事件 #${ev.id} 存在类型非法的输入（${inp.kind}）`);
      }
    }
  }

  if (errors.length) throw new ValidationError(errors);

  // ---- 引用未来批次（前序批次必须在更早时间加工） -------------------------
  for (const ev of events) {
    if (ev.kind !== 'process') continue;
    for (const inp of ev.inputs ?? []) {
      if (inp.kind !== 'batch') continue;
      const src = eventByBatchNo.get(inp.ref_batch_no);
      if (src.occ_at >= ev.occ_at) {
        errors.push(
          `事件 #${ev.id}（批次 ${ev.batch_no}，${ev.occ_at}）引用了未来/同时刻批次「${inp.ref_batch_no}」（${src.occ_at}），前序批次必须更早产出`
        );
      }
    }
  }

  // ---- 循环检测（批次引用图） -------------------------------------------
  const state = new Map(); // 0=访问中 1=完成
  const cyclePath = (no, stack) => {
    const st = state.get(no);
    if (st === 0) {
      const cyc = stack.slice(stack.indexOf(no));
      errors.push(`批次引用形成循环：${[...cyc, no].join(' → ')}`);
      return true;
    }
    if (st === 1) return false;
    state.set(no, 0);
    stack.push(no);
    const ev = eventByBatchNo.get(no);
    for (const inp of ev.inputs ?? []) {
      if (inp.kind === 'batch' && cyclePath(inp.ref_batch_no, stack)) return true;
    }
    stack.pop();
    state.set(no, 1);
    return false;
  };
  for (const no of eventByBatchNo.keys()) {
    if (!state.has(no)) cyclePath(no, []);
  }

  if (errors.length) throw new ValidationError(errors);

  // ---- 时间排序重算 ------------------------------------------------------
  // 同时间但不同设备允许；次序仅影响无冲突场景，加 id 作为稳定次序。
  const ordered = [...events].sort((a, b) =>
    a.occ_at < b.occ_at ? -1 : a.occ_at > b.occ_at ? 1 : a.id - b.id
  );

  /** 设备残留：{ allergens:Set, pathNodes:[] }，路径以"留下残留的批次"为根 */
  const residue = new Map();
  for (const eq of equipment) residue.set(eq.id, { allergens: new Set(), pathNodes: [] });

  const batches = new Map(); // batch_no -> 产出结果

  for (const ev of ordered) {
    const r = residue.get(ev.equipment_id);

    if (ev.kind === 'clean') {
      if (ev.verified) {
        // 已核实清洗：清空残留
        r.allergens = new Set();
        r.pathNodes = [];
      }
      // 未核实清洗：残留保持不变（仍可能携带过敏原）
      continue;
    }

    // 加工事件
    const selfNode = node('batch', ev.id, ev.batch_no, [], ev.occ_at);
    const pathNodes = [];
    const allergens = new Set();

    const addRooted = (allergensFrom, sourceNodes) => {
      for (const a of allergensFrom) {
        allergens.add(a);
        pathNodes.push({ allergen: a, nodes: [selfNode, ...sourceNodes] });
      }
    };

    for (const inp of ev.inputs ?? []) {
      if (inp.kind === 'material') {
        const m = materialById.get(inp.ref_id);
        addRooted(
          m.allergens,
          [node('material', m.id, m.name, SORTED(m.allergens))]
        );
      } else {
        const src = batches.get(inp.ref_batch_no); // 时间更早，必然已算出
        for (const n of src.pathNodes) addRooted([n.allergen], n.nodes);
      }
    }

    // 设备残留并集（换线前未清洗的过敏原带入本批次）
    const eqName = equipmentById.get(ev.equipment_id)?.name ?? `设备#${ev.equipment_id}`;
    for (const n of r.pathNodes) {
      // 残留路径以"留下残留的批次"为根，这里插入设备残留标记节点
      const residueNode = node(
        'residue',
        ev.equipment_id,
        `${eqName} 设备残留（源自 ${n.nodes[0].label}）`,
        [n.allergen],
        null
      );
      addRooted([n.allergen], [residueNode, ...n.nodes]);
    }

    const resultAllergens = SORTED([...allergens]);

    // 登记本批次产出
    const deduped = dedupePathNodes(pathNodes);
    batches.set(ev.batch_no, {
      batchNo: ev.batch_no,
      eventId: ev.id,
      equipmentId: ev.equipment_id,
      occAt: ev.occ_at,
      allergens: resultAllergens,
      pathNodes: deduped,
    });

    // 更新设备残留：本次产出覆盖性地把产出过敏原留在设备上
    // （产出集合本身已是输入∪旧残留，故直接以本批次来源路径重建该设备残留）
    r.allergens = new Set(resultAllergens);
    r.pathNodes = deduped.map((p) => ({ allergen: p.allergen, nodes: [...p.nodes] }));
  }

  const equipmentResidue = new Map();
  for (const eq of equipment) {
    const r = residue.get(eq.id);
    equipmentResidue.set(eq.id, {
      allergens: SORTED([...r.allergens]),
      pathNodes: dedupePathNodes(r.pathNodes),
    });
  }

  return { batches, equipmentResidue, orderedEvents: ordered };
}

function dedupePathNodes(nodes) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    const k = pathKey(n);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(n);
    }
  }
  return out.sort((a, b) => (a.allergen < b.allergen ? -1 : a.allergen > b.allergen ? 1 : 0));
}

// 供持久层/接口序列化：Map -> 数组，节点补齐可读字段
export function serializeBatches(batches) {
  return [...batches.values()].sort((a, b) =>
    a.occAt < b.occAt ? -1 : a.occAt > b.occAt ? 1 : a.eventId - b.eventId
  );
}
