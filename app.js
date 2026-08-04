/* =============================================================================
 * K-POP LIVE MAP — App logic (static site, no backend)
 *   - 数据源：./data/concerts.json（GitHub Actions 每日更新）
 *     加载失败时回退到 data.js 的 FALLBACK_CONCERTS。
 *   - Leaflet 世界地图 + 演出标记（含同场馆聚合）
 *   - 按 时间 / 地点 / 艺人 / 规模 / 演出类型 / 售票状态 筛选
 * ============================================================================= */

const GUIDES = window.PLATFORM_GUIDES || {};

const STATUS_LABEL = {
  on_sale: '开售中',
  presale: '预售',
  sold_out: '已售罄',
  announced: '待开票',
};
const TIER_LABEL = {
  major: '顶流',
  rising: '新星 / 小众',
  soloist: '个人 / 小分队',
  festival: '音乐节',
};
const TYPE_LABEL = {
  concert: '演唱会',
  fanmeeting: '见面会',
  festival: '音乐节',
};
const REGION_LABEL = {
  Korea: '🇰🇷 韩国',
  Japan: '🇯🇵 日本',
  Singapore: '🇸🇬 新加坡',
  HongKong: '🇭🇰 香港',
  Macau: '🇲🇴 澳门',
  HongKongMacau: '🇭🇰🇲🇴 港澳',
  Philippines: '🇵🇭 菲律宾',
  Thailand: '🇹🇭 泰国',
  Indonesia: '🇮🇩 印尼',
  Malaysia: '🇲🇾 马来西亚',
  USA: '🇺🇸 美国',
  Other: '🌏 其他',
};

function inferConcertType(concert) {
  const text = `${concert.artist || ''} ${concert.tour || ''}`.trim().toLowerCase();
  if (concert.type && TYPE_LABEL[concert.type]) return concert.type;
  if ((concert.tier || '') === 'festival' || /festival|waterbomb|lollapalooza|kcon|music bank|hallyupopfest|hallyu pop fest|a-nation|anation/.test(text)) {
    return 'festival';
  }
  if (/fan meeting|fanmeeting|见面会|fan con|fancon|fan-con|fan concert/.test(text)) {
    return 'fanmeeting';
  }
  return 'concert';
}

function normalizeConcert(concert) {
  return {
    ...concert,
    type: inferConcertType(concert),
    platforms: Array.isArray(concert.platforms) ? concert.platforms : [],
  };
}

let CONCERTS = (window.KPOP_DATA && window.KPOP_DATA.CONCERTS ? window.KPOP_DATA.CONCERTS : []).map(normalizeConcert);
let visibleConcerts = [];

// ---------------- State ----------------
const state = {
  q: '',
  region: 'all',
  tier: new Set(),
  type: 'all',
  status: 'all',
  from: '',
  to: '',
  sort: 'date',
  activeId: null,
};

// ---------------- Map init ----------------
const map = L.map('map', { zoomControl: false, worldCopyJump: true }).setView([25, 115], 3);
L.control.zoom({ position: 'bottomright' }).addTo(map);

// Base map (Esri primary in CN, OSM fallback)
const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
const OSM_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

let baseLayerSwitched = false;
let esriErrorStreak = 0;
const ESRI_ERROR_STREAK_LIMIT = 6;

const esriLayer = L.tileLayer(ESRI_TILES, {
  attribution: 'Tiles © Esri',
  maxZoom: 19,
});

// If Esri is unreachable for the user (e.g. some overseas networks), fallback to OSM once.
esriLayer.on('tileload', () => { esriErrorStreak = 0; });
esriLayer.on('tileerror', () => {
  esriErrorStreak += 1;
  if (baseLayerSwitched) return;
  if (esriErrorStreak < ESRI_ERROR_STREAK_LIMIT) return;

  baseLayerSwitched = true;
  map.removeLayer(esriLayer);

  const osmLayer = L.tileLayer(OSM_TILES, {
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: 'abc',
    maxZoom: 19,
  });
  osmLayer.addTo(map);
});

esriLayer.addTo(map);

const markerLayer = L.layerGroup().addTo(map);
let markerIndex = {};

const TIER_COLOR = {
  major: 'linear-gradient(135deg,#ff3d9a,#8b5cff)',
  rising: 'linear-gradient(135deg,#22e3d4,#3a8dff)',
  soloist: 'linear-gradient(135deg,#ffcf5c,#ff9f45)',
  festival: 'linear-gradient(135deg,#8b5cff,#22e3d4)',
};
const TIER_ICON = { major: '★', rising: '✦', soloist: '♪', festival: '❋' };

// ---------------- Helpers ----------------
function fmtDate(d, end) {
  const opt = { month: 'short', day: 'numeric' };
  const s = new Date(d + 'T00:00:00').toLocaleDateString('en-US', opt);
  if (end && end !== d) {
    const e = new Date(end + 'T00:00:00').toLocaleDateString('en-US', opt);
    return `${s} – ${e}, ${d.slice(0, 4)}`;
  }
  return `${s}, ${d.slice(0, 4)}`;
}

function fmtDateTime(c) {
  const dateLabel = fmtDate(c.date, c.endDate);
  return c.time ? `${dateLabel} · ${c.time}` : dateLabel;
}

function getMarkerGradient(tier) {
  return TIER_COLOR[tier] || 'linear-gradient(135deg,#22e3d4,#8b5cff)';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function matches(c) {
  const type = c.type || 'concert';
  const today = new Date().toISOString().slice(0, 10);
  const endD = c.endDate || c.date;
  if (endD < today) return false;
  if (c.status === 'sold_out') return false;

  if (state.q) {
    const hay = `${c.artist} ${c.tour} ${c.city} ${c.venue} ${c.country}`.toLowerCase();
    if (!hay.includes(state.q.toLowerCase())) return false;
  }
  if (state.region !== 'all') {
    if (state.region === 'asia_other') {
      if (!['Indonesia'].includes(c.region)) return false;
    } else if (state.region === 'HongKongMacau') {
      if (!['HongKong', 'Macau'].includes(c.region)) return false;
    } else if (c.region !== state.region) {
      return false;
    }
  }
  if (state.tier.size && !state.tier.has(c.tier)) return false;
  if (state.type !== 'all' && type !== state.type) return false;
  if (state.status !== 'all' && c.status !== state.status) return false;
  if (state.from && c.date < state.from) return false;
  if (state.to && c.date > state.to) return false;
  return true;
}

function sortList(arr) {
  const a = [...arr];
  if (state.sort === 'date') a.sort((x, y) => x.date.localeCompare(y.date));
  if (state.sort === 'artist') a.sort((x, y) => x.artist.localeCompare(y.artist));
  if (state.sort === 'capacity') a.sort((x, y) => (y.capacity || 0) - (x.capacity || 0));
  return a;
}

function scrollCardIntoView(id) {
  const active = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function syncActiveCard(scroll = false) {
  document.querySelectorAll('.card').forEach(card => {
    card.classList.toggle('active', card.dataset.id === state.activeId);
  });
  if (scroll && state.activeId) scrollCardIntoView(state.activeId);
}

function setActiveConcert(id, { scroll = false } = {}) {
  state.activeId = id;
  syncActiveCard(scroll);
}

function focusConcert(id, { flyTo = true, openPopup = true, scroll = true } = {}) {
  const c = visibleConcerts.find(x => x.id === id) || CONCERTS.find(x => x.id === id);
  if (!c) return;
  setActiveConcert(id, { scroll });
  const m = markerIndex[id];
  if (flyTo) map.flyTo([c.lat, c.lng], 6, { duration: 0.8 });
  if (m && openPopup) {
    m._primaryId = id;
    const openAndScroll = () => {
      openConcertPopup(m, id);
    };
    if (flyTo) setTimeout(openAndScroll, 500);
    else openAndScroll();
  }
}

function scrollPopupConcert(id) {
  if (!id) return;
  const popupEl = map.getContainer().querySelector(`.pop-section[data-concert-id="${CSS.escape(id)}"]`);
  if (!popupEl) return;
  popupEl.classList.add('active');
  popupEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function openConcertPopup(marker, targetId) {
  if (!marker) return;
  map.closePopup();
  marker._primaryId = targetId || marker._primaryId;
  if (marker._events) marker.setPopupContent(popupHtml(marker._events));
  marker.openPopup();
  setTimeout(() => scrollPopupConcert(marker._primaryId), 80);
}

// ---------------- Markers ----------------
function renderMarkers(list) {
  markerLayer.clearLayers();
  markerIndex = {};

  const groups = {};
  list.forEach(c => {
    const key = c.lat.toFixed(3) + ',' + c.lng.toFixed(3);
    (groups[key] = groups[key] || []).push(c);
  });

  Object.entries(groups).forEach(([key, events]) => {
    const lead = events[0];
    const multi = events.length > 1;
    const html = `<div class="kpin ${multi ? 'multi' : ''}" data-count="${events.length}"
        style="background:${getMarkerGradient(lead.tier)}">
        <span>${TIER_ICON[lead.tier] || '♪'}</span></div>`;
    const icon = L.divIcon({ html, className: '', iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -32] });
    const m = L.marker([lead.lat, lead.lng], { icon }).addTo(markerLayer);
    m.bindPopup(popupHtml(events), { closeButton: true, autoClose: true, closeOnClick: true, maxWidth: 380, maxHeight: Math.floor(window.innerHeight * 0.6) });
    m._events = events;
    m._primaryId = events.some(e => e.id === state.activeId) ? state.activeId : events[0].id;
    markerIndex[key] = m;
    events.forEach(e => { markerIndex[e.id] = m; });

    m.on('click', () => {
      const targetId = events.some(e => e.id === state.activeId) ? state.activeId : events[0].id;
      m._primaryId = targetId;
      setActiveConcert(targetId, { scroll: true });
      openConcertPopup(m, targetId);
    });

    m.on('popupopen', () => {
      const targetId = events.some(e => e.id === state.activeId) ? state.activeId : (m._primaryId || events[0].id);
      if (targetId) {
        setActiveConcert(targetId, { scroll: false });
        setTimeout(() => scrollPopupConcert(targetId), 0);
      }
    });
  });
}

function popupHtml(events) {
  const many = events.length > 1;
  const lead = events[0];
  const header = many
    ? `<div class="pop-artist">${esc(events.length + ' 场演出')}</div><div class="pop-tour">${esc(lead.venue)} · ${esc(lead.city)}</div>`
    : `<div class="pop-artist">${esc(lead.artist)}</div><div class="pop-tour">${esc(lead.tour)}</div>`;

  const blocks = events.map(c => {
    const platforms = c.platforms || [];
    const primary = platforms[0];
    return `
      <div class="pop-section${many ? ' multi' : ''}${c.id === state.activeId ? ' active' : ''}" data-concert-id="${esc(c.id)}">
        <div class="pop-event-title">
          <div>
            <div class="pop-event-artist">${esc(c.artist)}</div>
            <div class="pop-event-type">${TYPE_LABEL[c.type] || TYPE_LABEL.concert} · ${TIER_LABEL[c.tier] || '演出'}</div>
          </div>
          <span class="status-label lbl-${esc(c.status)}">● ${STATUS_LABEL[c.status] || esc(c.status)}</span>
        </div>
        <div class="pop-row"><span class="material-symbols-outlined">album</span>${esc(c.tour)}</div>
        <div class="pop-row"><span class="material-symbols-outlined">event</span>${fmtDateTime(c)}</div>
        <div class="pop-row"><span class="material-symbols-outlined">location_on</span>${esc(c.venue)}, ${esc(c.city)}, ${esc(c.country)}</div>
        ${c.note ? `<div class="pop-note">${esc(c.note)}</div>` : ''}
        <div class="pop-tickets">
          <div class="lbl">购票入口 · 点「中文教程」看购买指南</div>
          <div class="pop-plat">
            ${primary ? `
              <span class="plat-group">
                <a class="plat-buy" href="${esc(primary.url)}" target="_blank" rel="noopener" style="background:${esc(primary.color || '#8b5cff')}">
                  <span class="material-symbols-outlined">confirmation_number</span>购票 · ${esc(primary.name)}</a>
                ${GUIDES[primary.key] ? `<button class="plat-guide" type="button" data-guide="${esc(primary.key)}" title="中文购买教程">
                  <span class="material-symbols-outlined">menu_book</span>中文教程</button>` : ''}
              </span>` : '<div class="pop-empty">待补充官方票务链接</div>'}
          </div>
        </div>
        ${c.source ? `<div class="pop-source-row">
          <span class="material-symbols-outlined" style="font-size:14px;color:#9aa6ff">link</span>
          来源：<a href="${esc(c.source)}" target="_blank" rel="noopener">官方公告 / 报道</a>
        </div>` : ''}
      </div>`;
  }).join('');

  return `<div class="pop-header" style="background:${getMarkerGradient(lead.tier)}"><div class="pop-inner">${header}</div></div>
          <div class="pop-body">${blocks}</div>`;
}

// ---------------- List ----------------
function renderList(list) {
  const el = document.getElementById('list');
  if (!list.length) {
    el.innerHTML = `<div class="empty"><span class="material-symbols-outlined">search_off</span>
      <p>没有符合条件的演出</p><p style="font-size:11.5px">试试调整时间范围或清除筛选</p></div>`;
    return;
  }
  el.innerHTML = list.map(c => {
    const primary = (c.platforms || [])[0];
    return `
    <div class="card ${state.activeId === c.id ? 'active' : ''}" data-id="${esc(c.id)}">
      <div class="thumb" style="background:${getMarkerGradient(c.tier)}">${esc((c.artist || 'K').charAt(0))}</div>
      <div class="info">
        <div class="artist">${esc(c.artist)}
          <span class="badge tier-${esc(c.tier)}">${TIER_LABEL[c.tier] || ''}</span></div>
        <div class="tour">${esc(c.tour)}</div>
        <div class="meta">
          <span><span class="material-symbols-outlined">event</span>${fmtDate(c.date, c.endDate)}</span>
          <span><span class="material-symbols-outlined">place</span>${esc(c.city)} · ${esc(c.venue)}</span>
          <span><span class="material-symbols-outlined">local_activity</span>${TYPE_LABEL[c.type] || TYPE_LABEL.concert}</span>
          <span><span class="status-dot st-${esc(c.status)}"></span><span class="status-label lbl-${esc(c.status)}">${STATUS_LABEL[c.status] || ''}</span></span>
        </div>
        <div class="actions">
          ${primary ? `<a class="btn-buy" href="${esc(primary.url)}" target="_blank" rel="noopener" data-nocard="1"
             ><span class="material-symbols-outlined">confirmation_number</span>购票</a>` : ''}
          ${c.source ? `<a class="btn-src" href="${esc(c.source)}" target="_blank" rel="noopener" data-nocard="1"
             ><span class="material-symbols-outlined">link</span>来源</a>` : ''}
          ${primary && GUIDES[primary.key] ? `<button class="btn-src" type="button" data-guide="${esc(primary.key)}" data-nocard="1"
             ><span class="material-symbols-outlined">menu_book</span>中文教程</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('[data-nocard]')) return;
      focusConcert(card.dataset.id);
    });
  });
}

// ---------------- Stats ----------------
function updateStats(list) {
  document.getElementById('stat-shows').textContent = list.length;
  document.getElementById('stat-artists').textContent = new Set(list.map(c => c.artist)).size;
  document.getElementById('stat-cities').textContent = new Set(list.map(c => c.city)).size;
  document.getElementById('result-count').innerHTML = `<b>${list.length}</b> 场演出`;
}

// ---------------- Master refresh ----------------
function refresh(fitBounds = false) {
  const list = sortList(CONCERTS.filter(matches));
  visibleConcerts = list;
  if (state.activeId && !list.some(c => c.id === state.activeId)) state.activeId = null;
  renderMarkers(list);
  renderList(list);
  updateStats(list);
  syncActiveCard(false);
  if (fitBounds && list.length) {
    const b = L.latLngBounds(list.map(c => [c.lat, c.lng]));
    map.fitBounds(b, { padding: [60, 60], maxZoom: 5 });
  }
}

// ---------------- Filter bindings ----------------
document.getElementById('search').addEventListener('input', e => { state.q = e.target.value; refresh(); });
document.getElementById('from').addEventListener('change', e => { state.from = e.target.value; refresh(); });
document.getElementById('to').addEventListener('change', e => { state.to = e.target.value; refresh(); });
document.getElementById('status').addEventListener('change', e => { state.status = e.target.value; refresh(); });
document.getElementById('sort').addEventListener('change', e => { state.sort = e.target.value; refresh(); });

document.querySelectorAll('[data-region]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('[data-region]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.region = chip.dataset.region;
    refresh(true);
  });
});

document.querySelectorAll('[data-tier]').forEach(chip => {
  chip.addEventListener('click', () => {
    const t = chip.dataset.tier;
    if (state.tier.has(t)) {
      state.tier.delete(t);
      chip.classList.remove('active');
    } else {
      state.tier.add(t);
      chip.classList.add('active');
    }
    refresh();
  });
});

document.querySelectorAll('[data-type]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('[data-type]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.type = chip.dataset.type;
    refresh();
  });
});

document.getElementById('reset').addEventListener('click', () => {
  state.q = '';
  state.region = 'all';
  state.tier.clear();
  state.type = 'all';
  state.status = 'all';
  state.from = '';
  state.to = '';
  state.activeId = null;
  document.getElementById('search').value = '';
  document.getElementById('from').value = '';
  document.getElementById('to').value = '';
  document.getElementById('status').value = 'all';
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-region="all"]').classList.add('active');
  document.querySelector('[data-type="all"]').classList.add('active');
  refresh(true);
});

document.getElementById('fit').addEventListener('click', () => refresh(true));

// ---------------- Timestamps ----------------
function stampUpdated(dt) {
  const d = dt ? new Date(dt) : new Date();
  document.getElementById('updated-time').textContent =
    d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const noteEl = document.getElementById('data-updated');
  if (noteEl) {
    noteEl.textContent = d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }
}

// ---------------- Guide modal ----------------
function starStr(n) { return '★★★★★☆☆☆☆☆'.slice(5 - n, 10 - n); }

function fcClass(v) {
  if (v === '是（先行预售需要）') return 'fc-yes';
  if (v === '否') return 'fc-no';
  return 'fc-maybe';
}

function openGuide(key) {
  const g = GUIDES[key];
  if (!g) return;
  const el = document.getElementById('modal');
  const fcVal = g.fanclubNeed || '视场次而定';
  document.getElementById('modal-body').innerHTML = `
    <div class="fc-badge ${fcClass(fcVal)}">
      <span class="material-symbols-outlined">workspace_premium</span>
      <div class="fc-text"><span class="fc-cap">是否需要粉丝会员</span><b>${fcVal}</b></div>
    </div>
    <div class="guide-head">
      <div>
        <div class="guide-name">${g.name}</div>
        <div class="guide-sub">${g.region} · 上手难度 <span class="guide-stars">${starStr(g.difficulty)}</span></div>
      </div>
    </div>
    <div class="guide-grid">
      <div class="guide-cell"><span class="material-symbols-outlined">person_add</span>
        <div><b>是否需要注册</b><p>${g.account}</p></div></div>
      <div class="guide-cell"><span class="material-symbols-outlined">workspace_premium</span>
        <div><b>是否需要粉丝会员</b><p>${g.fanclub}</p></div></div>
      <div class="guide-cell"><span class="material-symbols-outlined">badge</span>
        <div><b>证件 / 实名要求</b><p>${g.idreq}</p></div></div>
      <div class="guide-cell"><span class="material-symbols-outlined">credit_card</span>
        <div><b>支付方式</b><p>${g.payment}</p></div></div>
    </div>
    <div class="guide-steps">
      <b>购买步骤</b>
      <ol>${g.steps.map(s => `<li>${s}</li>`).join('')}</ol>
    </div>
    <div class="guide-tip"><span class="material-symbols-outlined">tips_and_updates</span>${g.tip}</div>`;
  el.classList.add('open');
}
function closeGuide() { document.getElementById('modal').classList.remove('open'); }
window.openGuide = openGuide;
window.openTutorial = openGuide;
window.closeGuide = closeGuide;

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-guide]');
  if (btn) {
    e.preventDefault();
    openGuide(btn.dataset.guide);
  }
  if (e.target.id === 'modal' || e.target.closest('#modal-close')) closeGuide();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeGuide(); });

// ---------------- Load real-data JSON (static) ----------------
async function loadData() {
  const badge = document.getElementById('src-badge');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);

  try {
    const res = await fetch('./data/concerts.json', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('bad status ' + res.status);
    const data = await res.json();
    if (data && Array.isArray(data.concerts) && data.concerts.length) {
      CONCERTS = data.concerts.map(normalizeConcert);
      badge.className = 'src-badge live';
      badge.innerHTML = '<span class="material-symbols-outlined">verified</span>真实数据 · 每周自动更新';
      refresh(true);
      stampUpdated(data.updated_at);
      return;
    }
    throw new Error('empty');
  } catch (err) {
    // 静默回退到 data.js 兜底
    badge.className = 'src-badge sample';
    badge.innerHTML = '<span class="material-symbols-outlined">verified</span>真实数据（离线兜底版本）';
    refresh(true);
    stampUpdated();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------- Boot ----------------
stampUpdated();
refresh(true);          // 先用兜底数据渲染，避免白屏

if (location.protocol !== 'file:') {
  loadData();  // 线上：从 ./data/concerts.json 拉取最新
} else {
  // 本地 file:// 预览：浏览器通常禁止 fetch 本地 JSON，直接展示兜底数据
  const badge = document.getElementById('src-badge');
  badge.className = 'src-badge sample';
  badge.innerHTML = '<span class="material-symbols-outlined">verified</span>真实数据（本地预览）';
}
