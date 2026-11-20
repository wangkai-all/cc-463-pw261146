/* ---------- tiny DOM helpers (untrusted labels always via textContent) ---- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'html') node.innerHTML = value; // only for static markup
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const fmt = {
  money(cents) {
    if (cents == null) return '—';
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents) / 100;
    return `${sign}${abs.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  },
  compact(cents) {
    const abs = Math.abs(cents) / 100;
    if (abs >= 1e8) return `${(cents / 1e10).toFixed(2)} 亿`;
    if (abs >= 1e4) return `${(cents / 1e6).toFixed(2)} 万`;
    return fmt.money(cents);
  },
  int(n) { return n == null ? '—' : n.toLocaleString('zh-CN'); },
  time(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  },
  date(iso) { return iso ? iso.slice(0, 10) : '—'; },
};

const STATUS_META = {
  matched: { label: '完全一致', tone: 'good', icon: '✓' },
  explained: { label: '可解释', tone: 'accent', icon: '≈' },
  pending: { label: '待补数据', tone: 'warning', icon: '…' },
  conflict: { label: '真实冲突', tone: 'critical', icon: '!' },
};
const CATEGORY_META = {
  explainable: { label: '可解释差异', tone: 'accent', icon: '≈', color: 'var(--accent)', note: '机制已知，金额可对上' },
  pending_data: { label: '待补数据', tone: 'warning', icon: '…', color: 'var(--warning)', note: '来源未到齐或结算中' },
  conflict: { label: '真实冲突', tone: 'critical', icon: '!', color: 'var(--critical)', note: '来源证据互相矛盾' },
};
const SOURCE_META = {
  orders: { label: '订单', color: 'var(--accent)' },
  payments: { label: '支付', color: 'var(--good)' },
  refunds: { label: '退款', color: 'var(--serious)' },
};
const ACTION_TONE = { remap_key: 'primary', accept_diff: '', write_off: 'danger', manual_entry: '', defer_cutoff: '' };

let findingsRequest = 0;
const state = {
  view: 'overview',
  overview: null,
  findings: null,
  adjustments: null,
  recompute: null,
  batches: null,
  filters: { category: '', status: 'active', q: '' },
  adjustFilter: '',
  runFilter: '',
  loading: new Set(),
  lastRunId: null,
};

function actor() {
  return document.getElementById('actor-select').value;
}

async function api(path, { method = 'GET', body, silent = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-actor': encodeURIComponent(actor()),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.detail = data;
    if (!silent) toast(`${err.message}${data.details ? `：${data.details.slice(0, 2).join('；')}` : ''}`, true);
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(message, isError = false) {
  const root = document.getElementById('toast-root');
  root.replaceChildren(el('div', { class: `toast${isError ? ' error' : ''}`, role: 'status' }, message));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => root.replaceChildren(), isError ? 6000 : 3600);
}

/* ------------------------------------------------------------- components */

function badge(text, tone = 'neutral', icon = null) {
  return el('span', { class: `badge ${tone}` },
    el('span', { class: `dot ${tone}` }), icon ? el('span', { 'aria-hidden': 'true' }, icon) : null, text);
}

function categoryBadge(category) {
  const meta = CATEGORY_META[category];
  return badge(meta.label, meta.tone, meta.icon);
}

function statusBadge(status) {
  if (STATUS_META[status]) return badge(STATUS_META[status].label, STATUS_META[status].tone, STATUS_META[status].icon);
  if (status === 'open') return badge('待处理', 'warning');
  if (status === 'accepted') return badge('已接受', 'accent');
  if (status === 'resolved') return badge('已解决', 'good');
  if (status === 'waived') return badge('已挂起', 'warning');
  if (status === 'superseded') return badge('已取代', 'neutral');
  if (status === 'adjusted') return badge('调整中', 'accent');
  return badge(status, 'neutral');
}

function adjustmentStatusBadge(status) {
  if (status === 'proposed') return badge('待审批', 'warning');
  if (status === 'approved') return badge('已批准', 'good');
  return badge('已驳回', 'neutral');
}

function statTile({ label, value, delta, tone, cur = '¥' }) {
  return el('div', { class: 'card stat' },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value' }, cur ? el('span', { class: 'cur' }, cur) : null, value),
    delta ? el('div', { class: 'delta', style: tone ? `color:var(--${tone === 'critical' ? 'critical-ink' : tone === 'good' ? 'good-ink' : 'text-muted'})` : '' }, delta) : null);
}

/* ---------------------------------------------------------------- views */

function renderOverview() {
  const data = state.overview;
  const root = document.getElementById('root');
  if (!data || !data.run) {
    root.replaceChildren(el('div', { class: 'empty' },
      el('strong', {}, '还没有对账批次'),
      '先在「对账批次」页载入来源数据，或运行 npm run seed 生成演示数据。'));
    return;
  }
  const { run, categories, coverage, daily } = data;
  const s = run.summary;
  const days = daily.length ? [...new Set(daily.map((d) => d.date))].filter(Boolean).sort() : [];

  const heroValue = el('div', { class: 'value' },
    el('span', { class: 'cur' }, '¥'), fmt.money(Math.abs(s.amounts.conflict)));

  const kpis = el('div', { class: 'grid kpis' },
    el('div', { class: 'card stat' },
      el('div', { class: 'label' }, el('span', { class: 'swatch round', style: 'background:var(--good)' }), '完全一致'),
      el('div', { class: 'value' }, fmt.int(s.matched), el('span', { class: 'muted small', style: 'font-size:12px;font-weight:400' }, ' 单')),
      el('div', { class: 'delta' }, '应收 = 已收，无需调整')),
    el('div', { class: 'card stat' },
      el('div', { class: 'label' }, el('span', { class: 'swatch round', style: 'background:var(--accent)' }), '可解释差异'),
      el('div', { class: 'value' }, fmt.int(s.explained), el('span', { class: 'muted small', style: 'font-size:12px;font-weight:400' }, ' 单')),
      el('div', { class: 'delta' }, `${categories.explainable.n} 条发现项，机制已知`)),
    el('div', { class: 'card stat' },
      el('div', { class: 'label' }, el('span', { class: 'swatch round', style: 'background:var(--warning)' }), '待补数据'),
      el('div', { class: 'value' }, fmt.int(s.pending), el('span', { class: 'muted small', style: 'font-size:12px;font-weight:400' }, ' 单')),
      el('div', { class: 'delta', style: 'color:var(--warning-ink)' }, `待核差额 ¥${fmt.money(s.amounts.pending)}`)),
    el('div', { class: 'card stat' },
      el('div', { class: 'label' }, el('span', { class: 'swatch round', style: 'background:var(--critical)' }), '真实冲突'),
      el('div', { class: 'value' }, fmt.int(s.conflict), el('span', { class: 'muted small', style: 'font-size:12px;font-weight:400' }, ' 单')),
      el('div', { class: 'delta', style: 'color:var(--critical-ink)' }, `冲突差额 ¥${fmt.money(s.amounts.conflict)}`)));

  const catRows = ['explainable', 'pending_data', 'conflict'].map((key) => {
    const meta = CATEGORY_META[key];
    const entry = categories[key];
    return { key, meta, entry };
  });
  const maxAmount = Math.max(1, ...catRows.map((r) => r.entry.amount));
  const bars = el('div', { class: 'card' },
    el('h3', {}, '差异分类'),
    el('div', { class: 'sub' }, '按发现项金额（差额）拆分，未关闭项'),
    el('div', { class: 'bars' }, catRows.map(({ key, meta, entry }) => el('div', { class: 'bar-row' },
      el('div', { class: 'name' }, el('span', { class: 'icon', style: `color:${meta.color}` }, meta.icon), meta.label),
      el('div', { class: 'bar-track', role: 'img', 'aria-label': `${meta.label}：${entry.n} 条，金额 ${fmt.money(entry.amount)} 元` },
        el('div', { class: 'bar-fill', style: `width:${Math.max(2, (entry.amount / maxAmount) * 100)}%;background:${meta.color}` })),
      el('div', { class: 'amount' }, `¥${fmt.money(entry.amount)}`, el('small', {}, `${entry.n} 条发现项`))))),
    el('div', { class: 'legend' },
      el('span', {}, el('span', { class: 'mark', style: 'background:var(--accent)' }), '可解释：机制已知'),
      el('span', {}, el('span', { class: 'mark', style: 'background:var(--warning)' }), '待补：来源/结算未到'),
      el('span', {}, el('span', { class: 'mark', style: 'background:var(--critical)' }), '冲突：证据矛盾')));

  const coverageCard = renderCoverage(coverage);
  const recent = renderRecentRuns(data);
  const dailyCard = renderDaily(daily);

  const hero = el('div', { class: 'card' },
    el('div', { class: 'hero' },
      el('div', { class: 'label' }, '未解决冲突金额（按当前批次 #' + run.id + '）'),
      heroValue,
      el('div', { class: 'meta' },
        `对账范围 ${scopeLabelOf(run.scope)} · 重算 ${s.recomputed} 单 · 沿用 ${s.carried} 单 · ${fmt.time(run.run_at)}`)),
    el('div', { class: 'hr' }),
    el('div', { class: 'split' },
      el('button', { class: 'btn primary', onclick: () => regatherAndRun() }, '全量重算'),
      el('button', { class: 'btn', onclick: () => navigate('findings') }, '查看差异明细'),
      el('button', { class: 'btn', onclick: () => navigate('recompute') },
        `待重算范围 ${data.pending_scope}`)));

  root.replaceChildren(
    el('div', { class: 'grid two' }, hero, bars),
    el('div', { class: 'section-head' }, el('h2', {}, '对账批次'), el('p', {}, '同一批次内三类结果相互独立统计')),
    kpis,
    el('div', { class: 'section-head' }, el('h2', {}, '来源覆盖与批次'), el('p', {}, '单元格显示有效批次数，虚线表示该来源当日缺批')),
    el('div', { class: 'grid two' }, coverageCard, recent),
    el('div', { class: 'section-head' }, el('h2', {}, '按业务日的对账结果'), el('p', {}, '用于判断差异集中在哪一天')),
    dailyCard,
  );
}

function scopeLabelOf(scope) {
  if (!scope || scope.type === 'full') return '全量';
  if (scope.type === 'order') return `订单 ${scope.orderNo}`;
  if (scope.type === 'orders') return `${scope.orderNos.length} 个订单`;
  if (scope.type === 'batch') return `来源批次 #${scope.batchId}`;
  if (scope.type === 'source_date') return `来源日期 ${scope.sourceDate}`;
  return JSON.stringify(scope);
}

function renderCoverage(coverage) {
  const allDates = [...new Set(Object.values(coverage).flat().map((c) => c.date))].sort();
  const grid = el('div', { class: 'matrix', style: `grid-template-columns: 84px repeat(${Math.max(1, allDates.length)}, minmax(0,1fr))` });
  grid.append(el('div', { class: 'small muted' }, '来源 \\ 业务日'));
  for (const date of allDates) grid.append(el('div', { class: 'small muted nowrap' }, date.slice(5)));
  for (const [source, meta] of Object.entries(SOURCE_META)) {
    grid.append(el('div', { class: 'small', style: 'display:flex;align-items:center;gap:6px' },
      el('span', { class: 'swatch', style: `background:${meta.color}` }), meta.label));
    for (const date of allDates) {
      const entry = coverage[source].find((c) => c.date === date);
      if (!entry || entry.effective === 0) {
        grid.append(el('div', { class: 'cell absent', title: `${date} 无有效${meta.label}批次` }, '缺批'));
      } else {
        grid.append(el('div', {
          class: `cell${entry.superseded ? ' superseded' : ''}`,
          title: entry.superseded ? `${date} 有效 ${entry.effective} 批，已取代 ${entry.superseded} 批` : `${date} 有效 ${entry.effective} 批`,
        }, el('span', {}, entry.superseded ? '已修订' : '有效'), el('span', { class: 'n' }, `${entry.effective} 批`)));
      }
    }
  }
  return el('div', { class: 'card' }, el('h3', {}, '来源覆盖矩阵'), el('div', { class: 'sub' }, '每个来源每日只有最新修订计入事实'), grid);
}

function renderRecentRuns(data) {
  const rows = (data.batches || []).slice(0, 9);
  const tbody = el('tbody');
  for (const b of rows) {
    tbody.append(el('tr', {},
      el('td', { class: 'mono' }, `#${b.id}`),
      el('td', { class: 'nowrap' }, el('span', { class: 'swatch', style: `background:${SOURCE_META[b.source].color};margin-right:6px` }), SOURCE_META[b.source].label),
      el('td', { class: 'nowrap' }, b.business_date),
      el('td', {}, el('span', { class: 'mono small' }, b.source_ref), b.supersedes_ref ? el('div', { class: 'small muted' }, `取代 ${b.supersedes_ref}`) : null),
      el('td', {}, b.status === 'superseded' ? badge('已取代', 'neutral') : badge('有效', 'good')),
      el('td', { class: 'num' }, b.row_count)));
  }
  return el('div', { class: 'card' },
    el('h3', {}, '最近来源批次'),
    el('div', { class: 'sub' }, '修订批次保留并与被取代批次共存，随时可追溯'),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, '批次'), el('th', {}, '来源'), el('th', {}, '业务日'), el('th', {}, 'source_ref'), el('th', {}, '状态'), el('th', { class: 'num' }, '行数'))),
      tbody)),
    el('button', { class: 'btn ghost', style: 'margin-top:8px', onclick: () => navigate('batches') }, '全部批次 →'));
}

function renderDaily(daily) {
  const days = [...new Set(daily.map((d) => d.date))].filter(Boolean).sort();
  const tbody = el('tbody');
  for (const day of days) {
    const cells = daily.filter((d) => d.date === day);
    const total = cells.reduce((s, c) => s + c.n, 0);
    const tone = (status) => STATUS_META[status]?.tone || 'neutral';
    tbody.append(el('tr', {},
      el('td', {}, day),
      el('td', { class: 'num' }, total),
      ...['matched', 'explained', 'pending', 'conflict'].map((status) => {
        const cell = cells.find((c) => c.status === status);
        if (!cell) return el('td', { class: 'num muted' }, '0');
        return el('td', { class: 'num' },
          el('span', { style: 'display:inline-flex;align-items:center;gap:6px;justify-content:flex-end' },
            el('span', { class: `swatch round`, style: `background:var(--${status === 'matched' ? 'good' : status === 'explained' ? 'accent' : status === 'pending' ? 'warning' : 'critical'})` }),
            fmt.int(cell.n)));
      })));
  }
  return el('div', { class: 'card' }, el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, '业务日'), el('th', { class: 'num' }, '订单数'),
      el('th', { class: 'num' }, '一致'), el('th', { class: 'num' }, '可解释'), el('th', { class: 'num' }, '待补'), el('th', { class: 'num' }, '冲突'))),
    tbody)));
}

/* -------------------------------------------------------------- findings */

function renderFindings() {
  const data = state.findings;
  const root = document.getElementById('root');
  if (!data) { root.replaceChildren(el('div', { class: 'empty' }, '加载中…')); return; }
  const { findings, run } = data;
  if (!run) { root.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, '还没有对账批次'))); return; }

  const chipRow = el('div', { class: 'chipline' },
    ...[['', '全部'], ['explainable', '可解释差异'], ['pending_data', '待补数据'], ['conflict', '真实冲突']].map(([value, label]) =>
      el('button', {
        class: 'chip', 'aria-pressed': String(state.filters.category === value),
        onclick: () => { state.filters.category = value; loadFindings({ rerender: true }); },
      }, label)),
    el('span', { style: 'flex:1' }),
    ...[['active', '未关闭'], ['', '全部状态'], ['accepted', '已接受'], ['waived', '已挂起'], ['resolved', '已解决']].map(([value, label]) =>
      el('button', {
        class: 'chip', 'aria-pressed': String(state.filters.status === value),
        onclick: () => { state.filters.status = value; loadFindings({ rerender: true }); },
      }, label)));

  const search = el('input', {
    type: 'search', placeholder: '搜索订单号 / 标题 / 发现键', value: state.filters.q,
    oninput: debounce((e) => {
      state.filters.q = e.target.value;
      loadFindings({ rerender: true });
    }, 250),
  });

  const list = el('div');
  if (!findings.length) {
    list.append(el('div', { class: 'empty' }, el('strong', {}, '没有符合条件的发现项'), '调整筛选条件或切换分类。'));
  }
  for (const f of findings) list.append(renderFinding(f));

  root.replaceChildren(
    el('div', { class: 'section-head' }, el('h2', {}, `差异分类 · 批次 #${run.id}`),
      el('p', {}, `共 ${findings.length} 条 · 类别与状态相互独立`)),
    el('div', { class: 'filters' }, chipRow),
    el('div', { class: 'filters' }, el('label', {}, '检索'), search),
    list,
  );
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function renderFinding(f) {
  const meta = CATEGORY_META[f.category];
  const evidence = f.evidence || [];
  const evidenceNodes = evidence.map((e) => el('div', { class: `evidence${e.role === 'duplicate' ? ' duplicate' : ''}` },
    el('div', { class: 'src' }, el('span', { class: 'swatch', style: `background:${SOURCE_META[e.source]?.color || 'var(--text-muted)'}` }),
      SOURCE_META[e.source]?.label || e.source),
    el('div', {}, el('div', { class: 'ref' }, `${e.source_ref || ''} · ${e.row_id || ''}`),
      el('div', { class: 'small muted' }, `${e.business_date || ''}${e.role ? ` · ${roleLabel(e.role)}` : ''}${e.duplicate_of ? ` · 重复于 ${e.duplicate_of}` : ''}`)),
    el('div', { class: 'amt' }, `¥${fmt.money(e.amount_cents ?? 0)}`)));

  const adjustments = f.adjustments || [];
  const actionButtons = (f.allowed_actions || []).map((action) => el('button', {
    class: `btn sm ${ACTION_TONE[action] || ''}`,
    disabled: f.status !== 'open' && f.status !== 'adjusted',
    onclick: (event) => { event.preventDefault(); openAdjustmentModal(f, action); },
  }, actionLabel(action)));

  const detail = el('details', { class: 'finding' },
    el('summary', {},
      el('div', {},
        el('div', { class: 'title-line' },
          categoryBadge(f.category),
          f.severity === 'high' ? badge('高', 'critical') : f.severity === 'medium' ? badge('中', 'warning') : badge('低', 'neutral'),
          el('strong', {}, f.title),
          f.auto_fixable ? badge('可自动建议', 'neutral') : null),
        el('p', { class: 'detail' }, f.detail),
        el('div', { class: 'small muted', style: 'margin-top:4px' },
          el('span', { class: 'mono' }, f.order_no || '—'),
          ' · ', f.subtype,
          ' · ', `${evidence.length} 条证据`)),
      el('div', { class: 'money' },
        `¥${fmt.money(f.amount_cents)}`,
        el('small', {}, f.amount_cents === 0 ? '对账影响 0' : '涉及金额')),
      el('div', {}, statusBadge(f.status), adjustments.length ? el('div', { class: 'small muted', style: 'margin-top:4px' }, `${adjustments.length} 条调整记录`) : null),
      el('div', { class: 'small muted', style: 'text-align:right' }, '展开证据 ▾')),
    el('div', { class: 'finding-body' },
      el('div', { class: 'small muted', style: 'margin-bottom:8px' }, meta.note),
      el('div', { class: 'evidence-grid' }, evidenceNodes.length ? evidenceNodes : el('div', { class: 'small muted' }, '该发现项没有可引用的来源证据。')),
      el('div', { class: 'finding-actions' },
        actionButtons,
        el('button', { class: 'btn sm ghost', onclick: () => openTrace(f.order_no) }, '查看订单溯源 →')),
      adjustments.length ? el('div', { style: 'margin-top:12px' }, el('div', { class: 'small muted', style: 'margin-bottom:6px' }, '调整记录'),
        adjustments.map((a) => el('div', { class: 'evidence' },
          el('div', { class: 'src' }, `#${a.id}`),
          el('div', {}, el('div', {}, actionLabel(a.action), ' · ', adjustmentStatusBadge(a.status)),
            el('div', { class: 'small muted' }, a.reason)),
          el('div', { class: 'amt' }, a.approved_by ? `审批 ${a.approved_by}` : `提出 ${a.proposed_by}`)))) : null,
      f.remap && f.remap.length ? el('div', { class: 'callout', style: 'margin-top:10px' },
        el('strong', {}, '建议补键：'), '仅写入 ',
        f.remap.map((r) => `${SOURCE_META[r.source]?.label || r.source} 行 ${r.row_id} 的 ${r.field} → ${r.to}`).join('；'),
        '。订单与退款来源保持原样。') : null));

  return detail;
}

function roleLabel(role) {
  return {
    canonical: '计入事实', duplicate: '重复行（不计入）', payment: '支付流水', refund: '退款流水',
    order: '订单', payment_in_flight: '在途支付', refund_in_flight: '在途退款',
    current_revision: '当前修订', superseded_revision: '被取代修订', payment_voided: '作废支付',
    payment_candidate: '候选支付', pending_payment: '待处理支付',
  }[role] || role;
}

function actionLabel(action) {
  return {
    remap_key: '修正关联键', accept_diff: '接受差异', write_off: '差异核销',
    defer_cutoff: '挂起至下一批次', manual_entry: '人工登记',
  }[action] || action;
}

/* ----------------------------------------------------------- adjustments */

function renderAdjustments() {
  const root = document.getElementById('root');
  const data = state.adjustments;
  if (!data) { root.replaceChildren(el('div', { class: 'empty' }, '加载中…')); return; }
  const list = data.adjustments;
  const filterRow = el('div', { class: 'chipline' },
    ...[['', '全部'], ['proposed', '待审批'], ['approved', '已批准'], ['rejected', '已驳回']].map(([value, label]) =>
      el('button', {
        class: 'chip', 'aria-pressed': String(state.adjustFilter === value),
        onclick: () => { state.adjustFilter = value; loadAdjustments({ rerender: true }); },
      }, label)));

  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, '编号'), el('th', {}, '订单'), el('th', {}, '动作'), el('th', {}, '发现项'),
      el('th', { class: 'num' }, '金额'), el('th', {}, '提出'), el('th', {}, '状态'), el('th', {}, '操作'))),
    el('tbody'));

  for (const a of list) {
    table.querySelector('tbody').append(el('tr', {},
      el('td', { class: 'mono' }, `#${a.id}`),
      el('td', { class: 'mono' }, a.order_no || '—'),
      el('td', {}, actionLabel(a.action)),
      el('td', {}, el('div', {}, a.finding_title), el('div', { class: 'small muted' }, a.subtype || '')),
      el('td', { class: 'num' }, a.amount_cents ? `¥${fmt.money(a.amount_cents)}` : '—'),
      el('td', { class: 'small' }, a.proposed_by, el('div', { class: 'muted' }, fmt.time(a.proposed_at))),
      el('td', {}, adjustmentStatusBadge(a.status),
        a.approved_by ? el('div', { class: 'small muted' }, `${a.approved_by} · ${fmt.time(a.approved_at)}`) : null,
        a.applied_run_id ? el('div', { class: 'small muted' }, `已用于批次 #${a.applied_run_id}`) : null),
      el('td', {}, el('div', { class: 'split' },
        a.status === 'proposed' ? el('button', { class: 'btn sm primary', onclick: () => openApproveModal(a) }, '审批') : null,
        el('button', { class: 'btn sm ghost', onclick: () => openAdjustmentDetail(a.id) }, '详情')))));
  }

  const stats = data.adjustments.reduce((acc, a) => { acc[a.status] = (acc[a.status] || 0) + 1; return acc; }, {});

  root.replaceChildren(
    el('div', { class: 'section-head' }, el('h2', {}, '调整审批'),
      el('p', {}, `待审批 ${stats.proposed || 0} · 已批准 ${stats.approved || 0} · 已驳回 ${stats.rejected || 0}`)),
    el('div', { class: 'callout', style: 'margin-bottom:14px' },
      '调整是追加记录：批准后只写入对应来源的 override 或核销凭证，不修改任何来源原始行。审批通过会自动登记重算范围。'),
    el('div', { class: 'filters' }, filterRow),
    el('div', { class: 'card flat' }, list.length ? el('div', { class: 'table-wrap' }, table)
      : el('div', { class: 'empty' }, el('strong', {}, '没有调整记录'), '在「差异分类」中展开发现项即可提出调整。')));
}

/* ------------------------------------------------------------- recompute */

function renderRecompute() {
  const root = document.getElementById('root');
  const data = state.recompute;
  if (!data) { root.replaceChildren(el('div', { class: 'empty' }, '加载中…')); return; }
  const { pending, preview } = data;
  const scopeList = el('div', { class: 'scope-list' });
  if (!pending.length) {
    scopeList.append(el('div', { class: 'empty' }, el('strong', {}, '没有待重算范围'),
      '审批调整或导入新批次后，范围会自动登记在这里。'));
  }
  for (const s of pending) {
    scopeList.append(el('div', { class: 'scope-item' },
      el('div', {}, badge(scopeLabel(s.scope_type), 'accent')),
      el('div', { class: 'reason' }, s.reason,
        el('div', { class: 'small muted' }, `${s.order_no ? `订单 ${s.order_no} · ` : ''}${s.source_date || ''}${s.batch_id ? `批次 #${s.batch_id}` : ''} · ${fmt.time(s.created_at)}`)),
      el('div', { class: 'small muted nowrap' }, s.finding_title ? `发现项：${s.finding_title}` : '')));
  }

  const affected = preview.full
    ? el('div', { class: 'callout warning' }, '存在全量重算范围，将重算全部订单。')
    : preview.orders.length
      ? el('div', {}, el('div', { class: 'small muted', style: 'margin-bottom:6px' }, `影响 ${preview.orders.length} 个订单：`),
        el('div', { class: 'chipline' }, preview.orders.map((o) => el('button', { class: 'chip', onclick: () => openTrace(o) }, o))))
      : el('div', { class: 'small muted' }, '暂无受影响订单。');

  const runBtn = el('button', {
    class: 'btn primary', disabled: !pending.length,
    onclick: async () => {
      try {
        const result = await api('/api/recompute', { method: 'POST', body: { note: '手动触发范围重算' } });
        toast(`已重算批次 #${result.runId}：重算 ${result.preview.orders.length} 单`);
        await refreshAll();
        navigate('overview');
      } catch { /* toast already shown */ }
    },
  }, '按范围重算');

  const refresh = async () => { await loadRecompute(); renderRecompute(); };

  root.replaceChildren(
    el('div', { class: 'section-head' }, el('h2', {}, '重算范围'),
      el('p', {}, '只重算受影响的订单，其余订单沿用上一批次结果')),
    el('div', { class: 'grid two' },
      el('div', { class: 'card' },
        el('h3', {}, '待消费的重算范围'),
        el('div', { class: 'sub' }, '由审批通过的调整与批次导入自动登记'),
        el('div', { style: 'margin-top:12px' }, scopeList),
        el('div', { style: 'margin-top:14px;display:flex;gap:8px' },
          runBtn,
          el('button', { class: 'btn', onclick: refresh }, '刷新预览'))),
      el('div', { class: 'card' },
        el('h3', {}, '重算影响预览'),
        el('div', { class: 'sub' }, '范围会合并去重，未受影响的订单保持原结果'),
        el('div', { style: 'margin-top:12px' }, affected),
        el('div', { class: 'hr' }),
        el('div', { class: 'small muted' },
          '重算按订单为单位：受范围影响的订单重新读取三个来源的有效批次，未命中的订单沿用上一批次的结论与证据。'))));
}

function scopeLabel(type) {
  return { order: '订单', batch: '来源批次', source_date: '来源日期', full: '全量' }[type] || type;
}

/* --------------------------------------------------------------- batches */

function renderBatches() {
  const root = document.getElementById('root');
  const data = state.batches;
  if (!data) { root.replaceChildren(el('div', { class: 'empty' }, '加载中…')); return; }
  const rows = data.batches;
  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, '批次'), el('th', {}, '来源'), el('th', {}, '业务日'), el('th', {}, '修订'),
      el('th', {}, 'source_ref'), el('th', {}, '取代'), el('th', { class: 'num' }, '行数'),
      el('th', {}, '校验和'), el('th', {}, '状态'), el('th', {}, '载入时间'))),
    el('tbody'));
  for (const b of rows) {
    table.querySelector('tbody').append(el('tr', {},
      el('td', { class: 'mono' }, `#${b.id}`),
      el('td', {}, el('span', { class: 'swatch', style: `background:${SOURCE_META[b.source].color};margin-right:6px` }), SOURCE_META[b.source].label),
      el('td', {}, b.business_date),
      el('td', { class: 'num' }, `r${b.revision}`),
      el('td', { class: 'mono small' }, b.source_ref),
      el('td', { class: 'mono small muted' }, b.supersedes_ref || '—'),
      el('td', { class: 'num' }, b.row_count),
      el('td', { class: 'mono small muted' }, b.checksum),
      el('td', {}, b.status === 'superseded' ? badge('已取代', 'neutral') : b.status === 'reconciled' ? badge('已对账', 'accent') : badge('有效', 'good'),
        b.note ? el('div', { class: 'small muted', style: 'max-width:210px' }, b.note) : null),
      el('td', { class: 'small muted' }, fmt.time(b.loaded_at))));
  }

  const sample = JSON.stringify({
    source: 'payments',
    source_ref: 'psp-payments-20261106-v1',
    business_date: '2026-11-06',
    revision: 1,
    rows: [{ payment_no: 'PAY-20261106-0001', order_no: 'SO-20261104-0005', paid_at: '2026-11-06T10:00:00+08:00', business_date: '2026-11-06', amount: '430.00', channel: 'alipay', status: 'captured' }],
  }, null, 2);
  const textarea = el('textarea', { class: 'mono', style: 'min-height:190px', spellcheck: false });
  textarea.value = sample;
  const loadPanel = el('details', { class: 'card' },
    el('summary', { style: 'cursor:pointer;font-weight:600;font-size:13px' }, '载入新的来源批次'),
    el('div', { class: 'sub', style: 'margin:6px 0 10px' },
      '整批校验：任一行不合法则整批拒绝，避免半份数据被当成缺失数据。相同 source_ref + 日期 + 修订号重复提交会幂等返回原批次。'),
    textarea,
    el('div', { style: 'margin-top:10px' },
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          let body;
          try { body = JSON.parse(textarea.value); } catch { toast('JSON 解析失败', true); return; }
          try {
            const result = await api('/api/batches', { method: 'POST', body });
            toast(result.idempotent ? `批次 #${result.batchId} 已存在（幂等返回）` : `已导入批次 #${result.batchId}，${result.rowCount} 行`);
            const run = await api('/api/runs', { method: 'POST', body: { scope: { type: 'source_date', sourceDate: body.business_date }, note: `导入 ${body.source_ref}` } });
            toast(`已按 ${body.business_date} 重算，批次 #${run.runId}`);
            await refreshAll();
            renderBatches();
          } catch { /* toast already shown */ }
        },
      }, '导入并重算该来源日期')));

  root.replaceChildren(
    el('div', { class: 'section-head' }, el('h2', {}, '对账批次'), el('p', {}, '来源批次按业务日与修订号管理，被取代批次保留可查')),
    el('div', { class: 'grid three' }, ...Object.entries(SOURCE_META).map(([source, meta]) => {
      const list = rows.filter((b) => b.source === source);
      const effective = list.filter((b) => b.status !== 'superseded');
      return el('div', { class: 'card stat' },
        el('div', { class: 'label' }, el('span', { class: 'swatch round', style: `background:${meta.color}` }), `${meta.label}来源`),
        el('div', { class: 'value' }, fmt.int(effective.length), el('span', { style: 'font-size:12px;font-weight:400', class: 'muted' }, ' 个有效批次')),
        el('div', { class: 'delta' }, `${list.length - effective.length} 个已取代 · 覆盖 ${new Set(effective.map((b) => b.business_date)).size} 个业务日`));
    })),
    el('div', { style: 'height:14px' }),
    el('div', { class: 'card flat' }, el('div', { class: 'table-wrap' }, table)),
    el('div', { style: 'height:14px' }),
    loadPanel);
}

/* ---------------------------------------------------------------- modals */

function openModal(node, { wide = false } = {}) {
  const root = document.getElementById('modal-root');
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) closeModal(); } },
    el('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, node));
  root.replaceChildren(backdrop);
  document.addEventListener('keydown', escClose);
  backdrop.querySelector('button, input, select, textarea')?.focus();
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() {
  document.getElementById('modal-root').replaceChildren();
  document.removeEventListener('keydown', escClose);
}

async function openAdjustmentModal(finding, action) {
  const meta = ACTION_TONE[action];
  const evidence = finding.evidence || [];
  const chosen = new Map(evidence.map((e) => [`${e.source}|${e.row_id}|${e.batch_id}`, true]));
  const reason = el('textarea', { placeholder: '说明为什么这样处理，以及依据哪条证据' });
  const amount = el('input', { type: 'number', step: '0.01', min: '0', value: (finding.amount_cents / 100).toFixed(2) });
  const amountWrap = el('div', { class: 'field-row' }, el('div', { class: 'field' }, el('label', {}, '调整金额（元）'), amount));
  const needsAmount = ['write_off', 'manual_entry'].includes(action);
  const remap = (finding.remap || []);
  const needsRemap = action === 'remap_key';

  const evidenceBox = el('div', { class: 'check-evidence' });
  for (const [index, e] of evidence.entries()) {
    const key = `${e.source}|${e.row_id}|${e.batch_id}`;
    const input = el('input', { type: 'checkbox', checked: true });
    const label = el('label', { class: 'checked' }, input,
      el('div', {}, el('div', {}, `${SOURCE_META[e.source]?.label || e.source} · ${e.row_id}`),
        el('div', { class: 'small muted' }, `${e.source_ref || ''} · ${roleLabel(e.role)}`)),
      el('div', { class: 'mono small' }, `¥${fmt.money(e.amount_cents ?? 0)}`));
    input.addEventListener('change', () => {
      chosen.set(key, input.checked);
      label.classList.toggle('checked', input.checked);
    });
    evidenceBox.append(label);
  }

  const body = el('div', { class: 'modal-body' },
    el('div', { class: 'callout', style: 'margin-bottom:14px' },
      el('div', {}, el('strong', {}, finding.title), ' · ', categoryBadge(finding.category)),
      el('div', { class: 'small', style: 'margin-top:4px' }, finding.detail),
      el('div', { class: 'small muted', style: 'margin-top:4px' }, `发现目录 ${finding.finding_key} · 订单 ${finding.order_no || '—'}`)),
    needsRemap ? el('div', { class: 'callout good', style: 'margin-bottom:14px' },
      el('div', { class: 'small' }, '补键只写入指定来源的指定行，不改动其他来源的同名字段：'),
      el('div', { class: 'mono small', style: 'margin-top:5px' },
        remap.map((r) => `${r.source} · ${r.row_id} · ${r.field}: ${r.from ?? 'null'} → ${r.to}`).join('\n'))) : null,
    needsAmount ? amountWrap : null,
    el('div', { class: 'field' }, el('label', {}, '原因'), reason,
      el('div', { class: 'help' }, '至少 4 个字。将写入审批记录与审计日志。')),
    el('div', { class: 'field' }, el('label', {}, '引用的来源证据'),
      el('div', { class: 'help', style: 'margin-bottom:6px' }, '只能引用该发现项已记录的来源行；未勾选的证据不会被引用。'),
      evidenceBox));

  const foot = el('div', { class: 'modal-foot' },
    el('button', { class: 'btn', onclick: closeModal }, '取消'),
    el('button', {
      class: `btn primary ${meta === 'danger' ? 'danger' : ''}`,
      onclick: async () => {
        const selected = evidence.filter((e) => chosen.get(`${e.source}|${e.row_id}|${e.batch_id}`));
        try {
          await api(`/api/findings/${finding.id}/adjustments`, {
            method: 'POST',
            body: {
              action,
              reason: reason.value,
              amount_cents: needsAmount ? Math.round(Number(amount.value) * 100) : 0,
              remap: needsRemap ? remap.map((r) => ({ source: r.source, row_id: r.row_id, field: r.field, to: r.to })) : undefined,
              evidence: selected,
            },
          });
          toast('调整已提交，等待审批');
          closeModal();
          await refreshAll();
        } catch { /* toast already shown */ }
      },
    }, '提交调整'));

  openModal(el('div', {},
    el('div', { class: 'modal-head' },
      el('div', {}, el('h2', {}, `提出调整 · ${actionLabel(action)}`),
        el('div', { class: 'sub' }, actionHelp(action)))),
    body, foot));
}

function actionHelp(action) {
  return {
    remap_key: '只修正关联键，写入 override；来源原始行与其他来源不动。',
    accept_diff: '确认差异由已知机制导致，保留全部证据并计入已解释差异。',
    write_off: '为真实冲突建立核销差额，原凭证保留。',
    defer_cutoff: '待补数据挂起到下一批次，重算时继续保持开放。',
    manual_entry: '由人工登记金额与说明，形成可审计的人工凭证。',
  }[action] || '';
}

function openApproveModal(adjustment) {
  const note = el('textarea', { placeholder: '审批意见（可选）' });
  const selfCheck = el('input', { type: 'checkbox' });
  const isSelf = adjustment.proposed_by === actor();
  openModal(el('div', {},
    el('div', { class: 'modal-head' },
      el('div', {}, el('h2', {}, `审批调整 #${adjustment.id}`),
        el('div', { class: 'sub' }, `${actionLabel(adjustment.action)} · ${adjustment.order_no || ''} · ${adjustment.finding_title}`))),
    el('div', { class: 'modal-body' },
      el('div', { class: 'callout', style: 'margin-bottom:12px' },
        el('div', {}, el('strong', {}, '原因：'), adjustment.reason),
        el('div', { class: 'small muted', style: 'margin-top:4px' },
          `提出人 ${adjustment.proposed_by} · ${fmt.time(adjustment.proposed_at)} · 金额 ¥${fmt.money(adjustment.amount_cents)}`)),
      isSelf ? el('label', { class: 'callout warning', style: 'display:flex;gap:8px;align-items:flex-start;margin-bottom:12px' },
        selfCheck, el('span', {}, '你正在审批自己提出的调整。默认会被拒绝；如确需自审，请勾选此项。')) : null,
      el('div', { class: 'field' }, el('label', {}, '审批意见'), note),
      el('div', { class: 'callout' },
        '批准后将：① 写入对应来源的 override 或核销凭证；② 登记重算范围；③ 记录审批人与时间到审计日志。')),
    el('div', { class: 'modal-foot' },
      el('button', { class: 'btn', onclick: closeModal }, '取消'),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          try {
            await api(`/api/adjustments/${adjustment.id}/reject`, { method: 'POST', body: { note: note.value } });
            toast('已驳回');
            closeModal();
            await refreshAll();
          } catch { /* toast already shown */ }
        },
      }, '驳回'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            const result = await api(`/api/adjustments/${adjustment.id}/approve`, {
              method: 'POST',
              body: { note: note.value, allow_self_approval: selfCheck.checked },
            });
            toast(`已批准 #${adjustment.id}，已登记重算范围（${result.scope.type}）`);
            closeModal();
            await refreshAll();
          } catch { /* toast already shown */ }
        },
      }, '批准并登记重算'))));
}

async function openAdjustmentDetail(id) {
  const a = await api(`/api/adjustments/${id}`);
  const evidence = a.evidence || [];
  openModal(el('div', {},
    el('div', { class: 'modal-head' },
      el('div', {}, el('h2', {}, `调整 #${a.id}`),
        el('div', { class: 'sub' }, `${actionLabel(a.action)} · ${a.order_no || ''} · ${adjustmentStatusBadge(a.status).textContent}`))),
    el('div', { class: 'modal-body' },
      el('div', { class: 'field' }, el('label', {}, '原因'), el('div', {}, a.reason)),
      el('div', { class: 'field-row' },
        el('div', { class: 'field' }, el('label', {}, '提出'), el('div', {}, `${a.proposed_by} · ${fmt.time(a.proposed_at)}`)),
        el('div', { class: 'field' }, el('label', {}, '审批'), el('div', {}, a.approved_by ? `${a.approved_by} · ${fmt.time(a.approved_at)}` : '—'))),
      a.remap?.length ? el('div', { class: 'callout good', style: 'margin-bottom:12px' },
        el('strong', {}, '关联键变更：'), el('div', { class: 'mono small', style: 'margin-top:4px' },
          a.remap.map((r) => `${r.source} · ${r.row_id} · ${r.field}: ${r.from ?? 'null'} → ${r.to}`).join('\n'))) : null,
      el('div', { class: 'field' }, el('label', {}, '引用证据'),
        el('div', { class: 'evidence-grid' }, evidence.map((e) => el('div', { class: 'evidence' },
          el('div', { class: 'src' }, SOURCE_META[e.source]?.label || e.source),
          el('div', {}, el('div', { class: 'ref' }, `${e.source_ref || ''} · ${e.row_id || ''}`),
            el('div', { class: 'small muted' }, roleLabel(e.role))),
          el('div', { class: 'amt' }, `¥${fmt.money(e.amount_cents ?? 0)}`))))),
      a.applied_run_id ? el('div', { class: 'callout' }, `已应用于对账批次 #${a.applied_run_id} · ${fmt.time(a.applied_at)}`) : null),
    el('div', { class: 'modal-foot' }, el('button', { class: 'btn', onclick: closeModal }, '关闭'))));
}

async function openTrace(orderNo) {
  if (!orderNo) return;
  const trace = await api(`/api/orders/${encodeURIComponent(orderNo)}`);
  const col = (source, rows, total, extra) => el('div', { class: 'trace-col' },
    el('h4', {}, el('span', { class: 'swatch', style: `background:${SOURCE_META[source].color}` }), `${SOURCE_META[source].label}来源`),
    rows.length ? rows.map((r) => el('div', { class: `trace-row${r.is_duplicate ? ' struck' : ''}` },
      el('div', { class: 'line' },
        el('span', { class: 'mono' }, r.source_row_id || `${r.payment_no || r.refund_no || r.order_no}`),
        el('span', { class: 'money' }, `¥${fmt.money(source === 'orders' ? (r.gross_cents - r.discount_cents) : r.amount_cents)}`)),
      el('div', { class: 'line' },
        el('span', {}, `${r.business_date || ''} · ${r.status || ''}`),
        el('span', {}, r.source_ref || '')),
      (r.gross_cents != null ? el('div', { class: 'line' },
        el('span', {}, `原价 ¥${fmt.money(r.gross_cents)} · 折扣 ¥${fmt.money(r.discount_cents)}`), el('span', {}, '')) : null),
      r.is_duplicate ? el('div', { class: 'line' }, el('span', {}, `重复行 · 不计入 · 重复于 ${r.duplicate_of}`), el('span', {}, '')) : null,
      r.order_no && source !== 'orders' ? el('div', { class: 'line' }, el('span', {}, `关联订单 ${r.order_no}`), el('span', {}, '')) : null))
      : el('div', { class: 'empty', style: 'padding:14px' }, '无记录'),
    el('div', { class: 'trace-total' }, el('span', {}, '计入合计'), el('span', { class: 'money' }, `¥${fmt.money(total)}`)),
    extra || null);

  const orderTotal = trace.effective.orders.reduce((s, r) => s + r.gross_cents - r.discount_cents, 0);
  const paidTotal = trace.effective.payments.filter((p) => p.status === 'captured').reduce((s, r) => s + r.amount_cents, 0);
  const refundTotal = trace.effective.refunds.filter((r) => r.status === 'settled').reduce((s, r) => s + r.amount_cents, 0);

  const resultBox = trace.result ? el('div', { class: 'callout', style: 'margin-top:14px' },
    el('div', { class: 'split', style: 'justify-content:space-between' },
      el('div', {}, '对账结论 ', statusBadge(trace.result.status)),
      el('div', { class: 'mono' },
        `应收 ¥${fmt.money(trace.result.order_cents - (trace.raw.orders.find((o) => o.batch_status !== 'superseded')?.discount_cents || 0))} · 已收 ¥${fmt.money(trace.result.paid_cents)} · 已退 ¥${fmt.money(trace.result.refunded_cents)} · 差额 ¥${fmt.money(trace.result.delta_cents)}`)),
    trace.result.findings.length ? el('div', { style: 'margin-top:8px' },
      trace.result.findings.map((f) => el('div', { class: 'small' },
        categoryBadge(f.category), ' ', f.title, ' · ',
        f.status === 'accepted' ? '已由调整接受' : f.status === 'waived' ? '已挂起' : '未关闭'))) : null) : null;

  const overrideBox = trace.overrides.length ? el('div', { class: 'callout good', style: 'margin-top:14px' },
    el('div', {}, el('strong', {}, '已生效的来源 override（仅影响来源行）')),
    trace.overrides.map((o) => el('div', { class: 'mono small' },
      `${o.source} · ${o.source_row_id} · ${o.field} = ${JSON.parse(o.value_json)}`))) : null;

  const gapBox = trace.remap_targets.length ? el('div', { class: 'callout warning', style: 'margin-top:14px' },
    el('div', {}, '该订单是以下疑似错键支付的候选：'),
    trace.remap_targets.map((t) => el('div', { class: 'mono small' }, `${t.from} → ¥${fmt.money(t.payments.reduce((s, p) => s + p.amount_cents, 0))}`))) : null;

  openModal(el('div', {},
    el('div', { class: 'modal-head' },
      el('div', {}, el('h2', {}, `订单溯源 · ${trace.order_no}`),
        el('div', { class: 'sub' }, '三源原始行、重复行、override 与调整记录同时展示，互不覆盖'))),
    el('div', { class: 'modal-body' },
      el('div', { class: 'trace-grid', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' },
        col('orders', trace.raw.orders, orderTotal),
        col('payments', trace.raw.payments, paidTotal),
        col('refunds', trace.raw.refunds, refundTotal)),
      resultBox, overrideBox, gapBox,
      trace.adjustments.length ? el('div', { style: 'margin-top:14px' },
        el('div', { class: 'small muted', style: 'margin-bottom:6px' }, '调整记录'),
        trace.adjustments.map((a) => el('div', { class: 'evidence' },
          el('div', { class: 'src' }, `#${a.id}`),
          el('div', {}, `${actionLabel(a.action)} · `, adjustmentStatusBadge(a.status), el('div', { class: 'small muted' }, a.reason)),
          el('div', { class: 'amt' }, `¥${fmt.money(a.amount_cents)}`)))) : null,
      el('details', { style: 'margin-top:14px' },
        el('summary', { class: 'small muted', style: 'cursor:pointer' }, '查看原始报文'),
        el('pre', { class: 'json' }, JSON.stringify(trace.raw, null, 2)))),
    el('div', { class: 'modal-foot' }, el('button', { class: 'btn', onclick: closeModal }, '关闭'))),
  { wide: true });
}

async function regatherAndRun() {
  try {
    const result = await api('/api/runs', { method: 'POST', body: { scope: { type: 'full' }, note: '手动全量重算' } });
    toast(`已生成对账批次 #${result.runId}`);
    await refreshAll();
    navigate('overview');
  } catch { /* toast already shown */ }
}

/* --------------------------------------------------------------- loaders */

async function loadOverview() { state.overview = await api('/api/overview'); updateTabCounts(); }
async function loadFindings({ rerender = false } = {}) {
  const params = new URLSearchParams();
  if (state.filters.category) params.set('category', state.filters.category);
  if (state.filters.status) params.set('status', state.filters.status);
  if (state.filters.q) params.set('q', state.filters.q);
  const request = ++findingsRequest;
  const data = await api(`/api/findings?${params}`);
  if (request !== findingsRequest) return; // a newer query already landed
  state.findings = data;
  updateTabCounts();
  if (rerender && state.view === 'findings') renderFindings();
}
async function loadAdjustments({ rerender = false } = {}) {
  const params = new URLSearchParams();
  if (state.adjustFilter) params.set('status', state.adjustFilter);
  state.adjustments = await api(`/api/adjustments?${params}`);
  updateTabCounts();
  if (rerender && state.view === 'adjustments') renderAdjustments();
}
async function loadRecompute() { state.recompute = await api('/api/recompute'); }
async function loadBatches() { state.batches = await api('/api/batches'); }

function updateTabCounts() {
  const findingsEl = document.getElementById('tab-count-findings');
  const adjEl = document.getElementById('tab-count-adjustments');
  const scopeEl = document.getElementById('tab-count-scope');
  const ov = state.overview;
  if (ov) {
    const f = ov.run ? ov.run.summary : null;
    findingsEl.textContent = f ? (f.findings.explainable + f.findings.pending_data + f.findings.conflict) : '0';
    adjEl.textContent = ov.pending_adjustments;
    adjEl.classList.toggle('alert', ov.pending_adjustments > 0);
    scopeEl.textContent = ov.pending_scope;
    if (ov.run && state.lastRunId !== ov.run.id) state.lastRunId = ov.run.id;
  }
}

async function refreshAll() {
  await Promise.all([loadOverview(), loadFindings(), loadAdjustments(), loadRecompute(), loadBatches()]);
  // every mutation re-renders the active view against the refreshed data
  if (state.view === 'findings') renderFindings();
  else if (state.view === 'adjustments') renderAdjustments();
  else if (state.view === 'recompute') renderRecompute();
  else if (state.view === 'batches') renderBatches();
  else renderOverview();
}

const VIEWS = {
  overview: () => renderOverview(),
  findings: () => renderFindings(),
  adjustments: () => renderAdjustments(),
  recompute: () => renderRecompute(),
  batches: () => renderBatches(),
};

function navigate(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  const root = document.getElementById('root');
  root.setAttribute('data-view', view);
  if (view === 'overview') renderOverview();
  else if (view === 'findings') { root.replaceChildren(el('div', { class: 'empty' }, '加载中…')); renderFindings(); }
  else if (view === 'adjustments') renderAdjustments();
  else if (view === 'recompute') renderRecompute();
  else if (view === 'batches') renderBatches();
}

/* ------------------------------------------------------------------ boot */

document.getElementById('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  root.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => navigate(tab.dataset.view));
}

refreshAll().then(() => {
  navigate(state.view);
}).catch((err) => {
  document.getElementById('root').replaceChildren(el('div', { class: 'empty' },
    el('strong', {}, '加载失败'), err.message));
});
