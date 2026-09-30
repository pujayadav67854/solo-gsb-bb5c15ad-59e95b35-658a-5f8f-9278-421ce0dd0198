/* 浏览器前端：所有变更经 API 事务提交，服务端重算后返回全量状态，页面重新渲染。 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let state = null;

async function api(path, options = {}) {
  hideError();
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showError((data.details || [data.error || `请求失败（${res.status}）`]).join('\n'));
    throw Object.assign(new Error(data.error || 'request failed'), { details: data.details });
  }
  return data;
}

function showError(msg) {
  const el = $('#error-banner');
  el.textContent = '⚠ 提交被拒绝（整次提交未写入任何数据）：\n' + msg;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function hideError() { $('#error-banner').classList.add('hidden'); }

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---- 标签 / 路径渲染 ----------------------------------------------------

function allergenTags(allergens, { residueLike = false } = {}) {
  if (!allergens || !allergens.length) return '<span class="tag tag-none">无过敏原</span>';
  return allergens
    .map((a) => `<span class="tag ${residueLike ? 'tag-residue' : ''}">${escapeHtml(a)}</span>`)
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pathBlock(pathNodes) {
  if (!pathNodes || !pathNodes.length) return '';
  const groups = new Map();
  for (const p of pathNodes) {
    if (!groups.has(p.allergen)) groups.set(p.allergen, []);
    groups.get(p.allergen).push(p.nodes);
  }
  const blocks = [...groups.entries()].map(([allergen, chains]) => {
    const uniq = new Map();
    for (const nodes of chains) {
      uniq.set(nodes.map((n) => `${n.kind}:${n.id}`).join('>'), nodes);
    }
    const chainHtml = [...uniq.values()].map((nodes) => {
      const html = nodes.map((n, i) => {
        const prefix = i === 0 ? '' : '<span class="arrow">←</span>';
        return `${prefix}<span class="node node-${n.kind}">${escapeHtml(n.label)}</span>`;
      }).join('');
      return `<div class="path-chain">${html}</div>`;
    }).join('');
    return `<div class="path-group"><div class="path-allergen">${escapeHtml(allergen)}</div>${chainHtml}</div>`;
  }).join('');
  return `<details class="paths"><summary>🔎 查看来源路径（${pathNodes.length} 条）</summary>${blocks}</details>`;
}

// ---- 顶栏残留概览 -------------------------------------------------------

function renderResidueSummary() {
  const dirty = state.equipment.filter((eq) => (state.equipmentResidue[eq.id]?.allergens || []).length);
  if (!dirty.length) {
    $('#residue-summary').textContent = '当前所有设备均无过敏原残留';
    return;
  }
  $('#residue-summary').textContent = '有残留设备：' +
    dirty.map((eq) => `${eq.name}（${state.equipmentResidue[eq.id].allergens.join('、')}）`).join('；');
}

// ---- 批次与放行 ---------------------------------------------------------

function renderBatches() {
  const list = $('#batches-list');
  if (!state.batches.length) {
    list.innerHTML = '<div class="empty">还没有批次，先到「事件录入」登记加工事件。</div>';
    return;
  }
  const eqName = Object.fromEntries(state.equipment.map((e) => [e.id, e.name]));
  const releasesByBatch = new Map();
  for (const r of state.releases) {
    if (!releasesByBatch.has(r.batch_no)) releasesByBatch.set(r.batch_no, []);
    releasesByBatch.get(r.batch_no).push(r);
  }

  list.innerHTML = state.batches.map((b) => {
    const releases = releasesByBatch.get(b.batchNo) || [];
    const relHtml = releases.length ? `
      <div class="release-lines">
        ${releases.map((r) => `
          <div class="release-row">
            <span>
              <span class="badge ${r.status}">${r.status === 'valid' ? '放行有效' : '放行已失效'}</span>
              ${escapeHtml(r.created_at)} · 放行人 ${escapeHtml(r.released_by || '-')}
              · 登记集合：${r.allergens_snapshot.length ? r.allergens_snapshot.map(escapeHtml).join('、') : '（无）'}
              ${r.note ? ` · ${escapeHtml(r.note)}` : ''}
            </span>
            ${r.status === 'valid' ? `<span class="card-meta">放行单号 #${r.id}</span>` : ''}
            ${r.status === 'invalid' ? `<div class="release-invalid-reason">失效原因：${escapeHtml(r.invalid_reason)}（${escapeHtml(r.invalidated_at || '')}）</div>` : ''}
          </div>`).join('')}
      </div>` : '<div class="card-meta" style="margin-top:8px">尚未登记放行</div>';

    return `
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">批次 ${escapeHtml(b.batchNo)}</div>
            <div class="card-meta">事件 #${b.eventId} · ${escapeHtml(eqName[b.equipmentId] || '?')} · ${b.occAt}</div>
          </div>
          <div class="card-actions">
            <button class="btn btn-primary btn-small" data-release="${escapeHtml(b.batchNo)}">登记放行</button>
          </div>
        </div>
        <div class="tags">${allergenTags(b.allergens)}</div>
        ${pathBlock(b.pathNodes)}
        ${relHtml}
      </div>`;
  }).join('');

  $$('[data-release]', list).forEach((btn) =>
    btn.addEventListener('click', () => openReleaseModal(btn.dataset.release)));
}

// 放行弹窗
function openReleaseModal(batchNo) {
  const b = state.batches.find((x) => x.batchNo === batchNo);
  $('#release-form').reset();
  $('#release-form [name=batch_no]').value = batchNo;
  $('#release-context').innerHTML =
    `<div><b>批次 ${escapeHtml(batchNo)}</b>（${b.occAt}）</div>
     <div style="margin-top:6px">按当前推导结果登记，放行后该过敏原集合被固化：</div>
     <div class="tags">${allergenTags(b.allergens)}</div>`;
  $('#release-modal').classList.remove('hidden');
}
function closeReleaseModal() { $('#release-modal').classList.add('hidden'); }

$('#release-cancel').addEventListener('click', closeReleaseModal);
$('#release-modal').addEventListener('click', (e) => {
  if (e.target.id === 'release-modal') closeReleaseModal();
});
$('#release-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    state = await api('/api/releases', {
      method: 'POST',
      body: {
        batch_no: f.get('batch_no'),
        released_by: f.get('released_by'),
        note: f.get('note'),
      },
    });
    closeReleaseModal();
    renderAll();
    toast('放行已按当时推导结果登记');
  } catch { /* banner 已显示 */ }
});

// ---- 事件 ---------------------------------------------------------------

function fillEquipmentOptions() {
  const sel = $('#event-equipment');
  const current = sel.value;
  const options = state.equipment.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('');
  if (sel.innerHTML !== options) sel.innerHTML = options;
  if (current) sel.value = current;
}

function inputRowHtml(inp = { kind: 'material' }) {
  const kind = inp.kind || 'material';
  const refs = kind === 'material'
    ? state.materials.map((m) =>
        `<option value="m${m.id}" ${kind === 'material' && inp.ref_id === m.id ? 'selected' : ''}>${escapeHtml(m.name)}${m.allergens.length ? `（${m.allergens.join('、')}）` : ''}</option>`).join('')
    : state.batches.map((b) =>
        `<option value="b:${escapeHtml(b.batchNo)}" ${kind === 'batch' && inp.ref_batch_no === b.batchNo ? 'selected' : ''}>${escapeHtml(b.batchNo)}（${b.occAt}）${b.allergens.length ? ` [${b.allergens.join('、')}]` : ' [无]'}</option>`).join('');
  return `
    <div class="input-row">
      <select class="kind-select inp-kind">
        <option value="material" ${kind === 'material' ? 'selected' : ''}>原料</option>
        <option value="batch" ${kind === 'batch' ? 'selected' : ''}>前序批次</option>
      </select>
      <select class="ref-select inp-ref">${refs}</select>
      <input class="qty-input inp-qty" type="text" placeholder="用量（可选）" value="${escapeHtml(inp.qty || '')}" />
      <button type="button" class="btn btn-danger btn-small inp-remove">移除</button>
    </div>`;
}

function addInputRow(inp) {
  $('#event-inputs').appendChild(htmlToElement(inputRowHtml(inp)));
  bindNewRow($('#event-inputs').lastElementChild);
}
function bindNewRow(row) {
  $('.inp-kind', row).addEventListener('change', () => {
    const qty = $('.inp-qty', row).value;
    row.replaceWith(htmlToElement(inputRowHtml({ kind: $('.inp-kind', row).value, qty })));
    bindNewRow($('#event-inputs').lastElementChild);
  });
  $('.inp-remove', row).addEventListener('click', () => row.remove());
}
function htmlToElement(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function collectInputs() {
  return $$('#event-inputs .input-row').map((row) => {
    const kind = $('.inp-kind', row).value;
    const ref = $('.inp-ref', row).value;
    const qty = $('.inp-qty', row).value.trim();
    return kind === 'material'
      ? { kind, ref_id: Number(ref.slice(1)), qty }
      : { kind, ref_batch_no: ref.slice(2), qty };
  });
}

function setEventMode(isProcess) {
  $('#process-fields').classList.toggle('hidden', !isProcess);
  $('#clean-fields').classList.toggle('hidden', isProcess);
}

$('#event-kind').addEventListener('change', (e) => setEventMode(e.target.value === 'process'));
$('#clean-verified').addEventListener('change', (e) => {
  $('[name=verified_by]').required = e.target.checked;
});

$('#btn-add-input').addEventListener('click', () => addInputRow());

$('#event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const kind = fd.get('kind');
  const id = fd.get('id');
  const body = {
    kind,
    equipment_id: Number(fd.get('equipment_id')),
    occ_at: fd.get('occ_at'),
    note: fd.get('note'),
  };
  if (kind === 'process') {
    body.batch_no = String(fd.get('batch_no') || '').trim();
    body.inputs = collectInputs();
  } else {
    body.verified = $('#clean-verified').checked;
    body.verified_by = fd.get('verified_by');
  }

  try {
    state = await api(id ? `/api/events/${id}` : '/api/events', {
      method: id ? 'PUT' : 'POST',
      body,
    });
    resetEventForm();
    renderAll();
    toast(id ? '事件已更正，受影响批次与设备残留已重算' : '事件已保存');
  } catch { /* banner */ }
});

function resetEventForm() {
  const form = $('#event-form');
  form.reset();
  $('[name=id]', form).value = '';
  $('#event-inputs').innerHTML = '';
  addInputRow();
  setEventMode(true);
  $('#event-submit').textContent = '保存事件';
  $('#event-cancel-edit').classList.add('hidden');
}

$('#event-cancel-edit').addEventListener('click', resetEventForm);

function renderEvents() {
  const eqName = Object.fromEntries(state.equipment.map((e) => [e.id, e.name]));
  const matName = Object.fromEntries(state.materials.map((m) => [m.id, m.name]));
  const list = $('#events-list');
  if (!state.events.length) {
    list.innerHTML = '<div class="empty">还没有事件。</div>';
    return;
  }
  list.innerHTML = state.events.map((ev) => {
    let body = '';
    if (ev.kind === 'process') {
      const inputs = ev.inputs.map((i) =>
        i.kind === 'material'
          ? `原料「${escapeHtml(matName[i.ref_id] || `#${i.ref_id}`)}」${i.qty ? ` ${escapeHtml(i.qty)}` : ''}`
          : `前序批次「${escapeHtml(i.ref_batch_no)}」${i.qty ? ` ${escapeHtml(i.qty)}` : ''}`
      ).map((s) => `<li>${s}</li>`).join('');
      body = `<div class="card-meta">产出批次 <b>${escapeHtml(ev.batch_no)}</b></div>
              <ul class="card-meta" style="margin:6px 0 0 18px;padding:0">${inputs}</ul>`;
    } else {
      body = `<div style="margin-top:6px">
        <span class="badge ${ev.verified ? 'clean-verified' : 'clean-unverified'}">
          ${ev.verified ? '已核实清洗 · 核实人 ' + escapeHtml(ev.verified_by || '') : '未核实清洗（残留保留）'}
        </span></div>`;
    }
    return `
      <div class="card">
        <div class="card-head">
          <div>
            <div class="card-title">
              #${ev.id} ${ev.kind === 'process' ? '加工' : '清洗'} · ${escapeHtml(eqName[ev.equipment_id] || '?')}
            </div>
            <div class="card-meta">${ev.occ_at}${ev.note ? ' · ' + escapeHtml(ev.note) : ''}</div>
          </div>
          <div class="card-actions">
            <button class="btn btn-small" data-edit="${ev.id}">更正</button>
            <button class="btn btn-small btn-danger" data-del="${ev.id}">删除</button>
          </div>
        </div>
        ${body}
      </div>`;
  }).join('');

  $$('[data-edit]', list).forEach((btn) =>
    btn.addEventListener('click', () => editEvent(Number(btn.dataset.edit))));
  $$('[data-del]', list).forEach((btn) =>
    btn.addEventListener('click', () => deleteEvent(Number(btn.dataset.del))));
}

function editEvent(id) {
  const ev = state.events.find((x) => x.id === id);
  if (!ev) return;
  switchTab('events');
  const form = $('#event-form');
  $('[name=id]', form).value = ev.id;
  $('[name=kind]', form).value = ev.kind;
  $('[name=equipment_id]', form).value = ev.equipment_id;
  $('[name=occ_at]', form).value = ev.occ_at;
  $('[name=note]', form).value = ev.note || '';
  setEventMode(ev.kind === 'process');

  if (ev.kind === 'process') {
    $('[name=batch_no]', form).value = ev.batch_no || '';
    $('#event-inputs').innerHTML = '';
    ev.inputs.forEach(addInputRow);
  } else {
    $('#clean-verified').checked = ev.verified;
    $('[name=verified_by]', form).value = ev.verified_by || '';
  }
  $('#event-submit').textContent = '保存更正（将重算后续批次）';
  $('#event-cancel-edit').classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteEvent(id) {
  if (!confirm(`确定删除事件 #${id}？\n若其它批次引用了它的产出批次，整次删除会被拒绝。`)) return;
  try {
    state = await api(`/api/events/${id}`, { method: 'DELETE' });
    resetEventForm();
    renderAll();
    toast('事件已删除，后续批次与残留已重算');
  } catch { /* banner */ }
}

// ---- 原料 ---------------------------------------------------------------

function renderAllergenDatalist() {
  $('#allergen-list').innerHTML = state.allergenOptions.map((a) => `<option value="${escapeHtml(a)}">`).join('');
  $('#allergen-picker').innerHTML = state.allergenOptions
    .map((a) => `<button type="button" class="allergen-chip" data-a="${escapeHtml(a)}">${escapeHtml(a)}</button>`)
    .join('');
  $$('#allergen-picker .allergen-chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const input = $('[name=allergens_text]', $('#material-form'));
      const cur = parseAllergenText(input.value);
      const a = chip.dataset.a;
      const next = cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a];
      input.value = next.join(', ');
      syncChips();
    }));
}

function parseAllergenText(t) {
  return [...new Set(String(t || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean))];
}
function syncChips() {
  const cur = parseAllergenText($('[name=allergens_text]', $('#material-form')).value);
  $$('#allergen-picker .allergen-chip').forEach((chip) =>
    chip.classList.toggle('on', cur.includes(chip.dataset.a)));
}

$('#material-form').addEventListener('input', (e) => {
  if (e.target.name === 'allergens_text') syncChips();
});

$('#material-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = fd.get('id');
  const body = {
    name: String(fd.get('name') || '').trim(),
    allergens: parseAllergenText(fd.get('allergens_text')),
  };
  try {
    state = await api(id ? `/api/materials/${id}` : '/api/materials', {
      method: id ? 'PUT' : 'POST',
      body,
    });
    resetMaterialForm();
    renderAll();
    toast(id ? '原料已更正，批次结果已重算' : '原料已添加');
  } catch { /* banner */ }
});

function resetMaterialForm() {
  const form = $('#material-form');
  form.reset();
  $('[name=id]', form).value = '';
  $('#material-submit').textContent = '添加原料';
  $('#material-cancel-edit').classList.add('hidden');
  syncChips();
}
$('#material-cancel-edit').addEventListener('click', resetMaterialForm);

function renderMaterials() {
  const list = $('#materials-list');
  list.innerHTML = state.materials.map((m) => `
    <div class="card">
      <div class="card-head">
        <div class="card-title">${escapeHtml(m.name)}</div>
        <div class="card-actions">
          <button class="btn btn-small" data-medit="${m.id}">更正</button>
          <button class="btn btn-small btn-danger" data-mdel="${m.id}">删除</button>
        </div>
      </div>
      <div class="tags">${allergenTags(m.allergens)}</div>
    </div>`).join('');

  $$('[data-medit]', list).forEach((btn) => btn.addEventListener('click', () => {
    const m = state.materials.find((x) => x.id === Number(btn.dataset.medit));
    const form = $('#material-form');
    $('[name=id]', form).value = m.id;
    $('[name=name]', form).value = m.name;
    $('[name=allergens_text]', form).value = m.allergens.join(', ');
    syncChips();
    $('#material-submit').textContent = '保存更正（将重算批次）';
    $('#material-cancel-edit').classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $$('[data-mdel]', list).forEach((btn) => btn.addEventListener('click', async () => {
    const m = state.materials.find((x) => x.id === Number(btn.dataset.mdel));
    if (!confirm(`确定删除原料「${m.name}」？（被事件引用时会被拒绝）`)) return;
    try {
      state = await api(`/api/materials/${m.id}`, { method: 'DELETE' });
      renderAll();
      toast('原料已删除');
    } catch { /* banner */ }
  }));
}

// ---- 设备 ---------------------------------------------------------------

$('#equipment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    state = await api('/api/equipment', { method: 'POST', body: { name: String(fd.get('name') || '').trim() } });
    e.target.reset();
    renderAll();
    toast('设备已添加');
  } catch { /* banner */ }
});

function renderEquipment() {
  const list = $('#equipment-list');
  list.innerHTML = state.equipment.map((eq) => {
    const r = state.equipmentResidue[eq.id] || { allergens: [], pathNodes: [] };
    return `
      <div class="card">
        <div class="card-head">
          <div class="card-title">${escapeHtml(eq.name)}</div>
          <div class="card-actions">
            <button class="btn btn-small btn-danger" data-edel="${eq.id}">删除设备</button>
          </div>
        </div>
        <div class="card-meta">截至最晚事件的设备残留</div>
        <div class="tags">${allergenTags(r.allergens, { residueLike: true })}</div>
        ${pathBlock(r.pathNodes)}
      </div>`;
  }).join('');

  $$('[data-edel]', list).forEach((btn) => btn.addEventListener('click', async () => {
    const eq = state.equipment.find((x) => x.id === Number(btn.dataset.edel));
    if (!confirm(`确定删除设备「${eq.name}」？该设备上的全部加工/清洗事件将一并删除，相关放行会失效。`)) return;
    try {
      state = await api(`/api/equipment/${eq.id}`, { method: 'DELETE' });
      renderAll();
      toast('设备及其事件已删除');
    } catch { /* banner */ }
  }));
}

// ---- 框架 ---------------------------------------------------------------

function renderAll() {
  fillEquipmentOptions();
  renderResidueSummary();
  renderBatches();
  renderEvents();
  renderMaterials();
  renderEquipment();
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

$('#btn-reload').addEventListener('click', async () => {
  state = await api('/api/state');
  renderAll();
  toast('已从本地数据库重新加载');
});

async function boot() {
  fillEquipmentOptions();
  state = await api('/api/state');
  fillEquipmentOptions();
  renderAllergenDatalist();
  resetEventForm();
  renderAll();
  syncChips();
}
boot().catch((e) => showError(e.message));
