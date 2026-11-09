/**
 * dsh-astro-plan — 自包含查询页面（无外部资源、无构建）。
 * 直接打开 http://127.0.0.1:<port>/astro-plan/ 使用。
 *
 * 查询区按「时间 / 目的地及出发地 / 天文参数 / 拍摄参数」四行分组，
 * 每行的查询要素强制排在同一行（内联样式，不依赖外部 CSS）。
 * 出发地点默认「目前所在地」，直线距离默认按浏览器定位计算。
 * 结果用 CSS Grid 行渲染（不用 <table>），每列位置由 inline grid-template-columns 固定，
 * 任何宿主样式覆盖都不会把内容挤到第一列。
 */

import { RENDER_SRC } from './skyview.js'

const CSS = `
/* ---------- 深浅色主题：默认深色，跟随系统/外观设置切浅色 ---------- */
:root{
  color-scheme:dark;
  --bg:#0b0f17; --head-bg1:#0f1622; --head-line:#1c2534;
  --panel:#101828; --panel-line:#1d2839; --field-bg:#0b1220; --field-line:#26334a;
  --text:#dbe3f0; --dim:#8b9ab2; --dim2:#7f8ea6; --label:#7fa6e8;
  --accent:#6ea8fe; --accent-2:#2c6cf6; --ok:#5ee0a0;
  --btn-bg:#2c6cf6; --btn-text:#fff; --ghost-bg:#1b2942; --ghost-line:#2c3f60; --ghost-text:#cfe0f7;
  --row-head:#0e1524; --row-line:#1a2434; --row-hover:#131c2e; --row-open:#16233a; --detail-bg:#0c1322;
  --dash:rgba(255,255,255,.07); --err:#f08a8a;
  /* 便签：深色模式下也是深色，但比结果表格更偏蓝、略亮，便于区分 */
  --note-bg1:#1b2230; --note-bg2:#151b26; --note-text:#dfe7f3; --note-title:#d8b46a;
  --note-sec:rgba(255,255,255,.05); --note-sec-line:rgba(255,255,255,.10);
  --note-kv-line:rgba(255,255,255,.08); --note-kv-key:#93a3bb; --note-kv-val:#e7eefa;
  --note-shadow:0 10px 24px rgba(0,0,0,.45);
}
@media (prefers-color-scheme: light){
  :root{
    color-scheme:light;
    --bg:#f4f6fb; --head-bg1:#ffffff; --head-line:#e2e8f2;
    --panel:#ffffff; --panel-line:#e2e8f2; --field-bg:#ffffff; --field-line:#cdd7e6;
    --text:#1d2735; --dim:#5b6b82; --dim2:#6b7c93; --label:#2f66c9;
    --accent:#2f66c9; --accent-2:#2563eb; --ok:#128a5a;
    --btn-bg:#2563eb; --btn-text:#fff; --ghost-bg:#eef3fb; --ghost-line:#c9d6ea; --ghost-text:#274b86;
    --row-head:#f0f4fa; --row-line:#e8edf5; --row-hover:#eef4ff; --row-open:#e4eeff; --detail-bg:#f7faff;
    --dash:rgba(20,40,70,.09); --err:#c02a2a;
    --note-bg1:#fffbe8; --note-bg2:#f7efcf; --note-text:#3b3320; --note-title:#8a6d2f;
    --note-sec:rgba(255,255,255,.72); --note-sec-line:rgba(140,110,50,.26);
    --note-kv-line:rgba(120,95,40,.22); --note-kv-key:#7a6a48; --note-kv-val:#3a3117;
    --note-shadow:0 6px 18px rgba(60,70,90,.18);
  }
}
/* 宿主/外链显式指定浅色时也生效（?theme=light 会给 <html data-theme="light">） */
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#f4f6fb; --head-bg1:#ffffff; --head-line:#e2e8f2;
  --panel:#ffffff; --panel-line:#e2e8f2; --field-bg:#ffffff; --field-line:#cdd7e6;
  --text:#1d2735; --dim:#5b6b82; --dim2:#6b7c93; --label:#2f66c9;
  --accent:#2f66c9; --accent-2:#2563eb; --ok:#128a5a;
  --btn-bg:#2563eb; --btn-text:#fff; --ghost-bg:#eef3fb; --ghost-line:#c9d6ea; --ghost-text:#274b86;
  --row-head:#f0f4fa; --row-line:#e8edf5; --row-hover:#eef4ff; --row-open:#e4eeff; --detail-bg:#f7faff;
  --dash:rgba(20,40,70,.09); --err:#c02a2a;
  --note-bg1:#fffbe8; --note-bg2:#f7efcf; --note-text:#3b3320; --note-title:#8a6d2f;
  --note-sec:rgba(255,255,255,.72); --note-sec-line:rgba(140,110,50,.26);
  --note-kv-line:rgba(120,95,40,.22); --note-kv-key:#7a6a48; --note-kv-val:#3a3117;
  --note-shadow:0 6px 18px rgba(60,70,90,.18);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
header{padding:14px 22px 8px;border-bottom:1px solid var(--head-line);background:linear-gradient(180deg,var(--head-bg1),var(--bg))}
h1{margin:0;font-size:19px;letter-spacing:.5px}
h1 span{color:var(--accent)}
h1 small{font-size:12px;font-weight:400;color:var(--dim2);letter-spacing:0;margin-left:8px}
.sub{color:var(--dim2);font-size:12px;margin-top:3px}
.wrap{max-width:1280px;margin:0 auto;padding:12px 18px 56px}

/* ---------- 查询区：四行分组，每行要素同一行 ---------- */
.panel{background:var(--panel);border:1px solid var(--panel-line);border-radius:12px;padding:8px 14px 10px}
.prow{display:grid;grid-template-columns:96px 1fr;gap:10px;align-items:center;padding:6px 0;border-bottom:1px dashed var(--dash)}
.prow:last-of-type{border-bottom:0}
.plabel{font-size:12px;color:var(--label);letter-spacing:.5px;white-space:nowrap}
.field{display:flex;flex-direction:column;gap:2px;flex:0 0 auto}
.field>label{font-size:11px;color:var(--dim2);white-space:nowrap}
select,input{background:var(--field-bg);border:1px solid var(--field-line);color:var(--text);border-radius:7px;padding:5px 7px;font-size:12px;min-width:0;text-align:left}
select:focus,input:focus{outline:1px solid var(--accent-2);border-color:var(--accent-2)}
.w-date{width:128px}
.w-region,.w-province{width:96px}
.w-site{width:152px}
.w-origin{width:118px}
.w-type{width:132px}
.w-alt,.w-bortle{width:64px}
.w-page{width:62px}
.w-format{width:90px}

/* ---------- 目标类型：两级菜单（左列分组 → 右列具体类型） ---------- */
.tmenu-field{position:relative}
.tbtn{width:132px;background:var(--field-bg);border:1px solid var(--field-line);color:var(--text);
  border-radius:7px;padding:5px 22px 5px 7px;font-size:12px;text-align:left;cursor:pointer;
  position:relative;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tbtn::after{content:'▾';position:absolute;right:7px;top:50%;transform:translateY(-50%);color:var(--dim2);font-size:10px}
.tbtn:hover{border-color:var(--accent-2)}
.tmenu{position:absolute;top:calc(100% + 4px);left:0;z-index:60;display:flex;gap:4px;
  background:var(--panel);border:1px solid var(--panel-line);border-radius:10px;padding:5px;
  box-shadow:0 12px 28px rgba(0,0,0,.4);max-height:300px}
.tmenu-col{display:flex;flex-direction:column;min-width:92px;max-height:288px;overflow:auto}
.tmenu-sub{min-width:140px;border-left:1px solid var(--panel-line);padding-left:4px}
.tmenu-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;
  border-radius:6px;font-size:12px;color:var(--text);cursor:pointer;white-space:nowrap}
.tmenu-item:hover{background:var(--row-hover)}
.tmenu-item.on{background:var(--row-open);color:var(--accent)}
.tmenu-arrow{color:var(--dim2);font-size:11px;line-height:1}
.pactions{display:flex;gap:10px;padding-top:9px}
button{background:var(--btn-bg);border:0;color:var(--btn-text);border-radius:7px;padding:7px 18px;font-size:13px;cursor:pointer}
button.ghost{background:var(--ghost-bg);border:1px solid var(--ghost-line);color:var(--ghost-text)}
button:disabled{opacity:.5;cursor:default}
.meta{margin:8px 0;color:var(--dim);font-size:12px;min-height:16px}

/* ---------- 结果：网格行（非 table） ---------- */
.tablewrap{overflow-x:auto;border:1px solid var(--panel-line);border-radius:12px;background:var(--panel)}
.reswrap{min-width:1040px}
.rrow{display:grid;align-items:center}
.rhead{font-size:12px;color:var(--dim);background:var(--row-head)}
.rhead>div{padding:7px 8px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ritem{font-size:13px;cursor:pointer}
.ritem>div{padding:6px 8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid var(--row-line)}
.ritem:hover>div{background:var(--row-hover)}
.ritem.open>div{background:var(--row-open)}
.rank{color:var(--accent);font-weight:700}
.sc{color:var(--ok);font-weight:700}
.cell-sub{display:block;font-size:11px;color:var(--dim2);overflow:hidden;text-overflow:ellipsis}
/* 最佳时段固定 220px：单行显示，不换行不截断 */
.c-window{white-space:nowrap;overflow:visible;text-overflow:clip;font-variant-numeric:tabular-nums}
.detail{display:grid;grid-template-rows:0fr;opacity:0;padding:0;background:var(--detail-bg);border-bottom:1px solid var(--row-line);transition:grid-template-rows .26s ease,opacity .2s ease}
.detail.open{grid-template-rows:1fr;opacity:1;animation:ap-detail-in .26s ease}
@keyframes ap-detail-in{from{grid-template-rows:0fr;opacity:0}to{grid-template-rows:1fr;opacity:1}}
.detail>div{min-height:0;overflow:hidden;padding:0 0 2px}
.pager{display:flex;gap:12px;align-items:center;justify-content:center;padding:10px 0 2px;font-size:12px;color:var(--dim)}
.pager button{padding:5px 14px;font-size:12px}

/* ---------- 详情：便签风格，限高滚动，不顶开下一行 ---------- */
.note{position:relative;margin:10px 12px 14px;padding:13px 15px 11px;border-radius:6px;
  background:linear-gradient(180deg,var(--note-bg1),var(--note-bg2));color:var(--note-text);
  box-shadow:var(--note-shadow);transform:rotate(-.25deg);
  max-height:64vh;overflow:auto;white-space:normal}
.note::before{content:'';position:absolute;top:-7px;left:50%;width:86px;height:16px;margin-left:-43px;
  background:rgba(255,255,255,.55);box-shadow:0 1px 3px rgba(0,0,0,.18);transform:rotate(-2deg)}
.note h5{margin:0 0 5px;font-size:12px;color:var(--note-title);letter-spacing:.6px;font-weight:700}
/* 两列：左侧 8 个便签，右侧整列画面模拟 */
.note .notegrid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:12px;align-items:start}
.note .noteleft{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.note .noteright{position:sticky;top:0}
@media (max-width:900px){ .note .notegrid{grid-template-columns:1fr} .note .noteright{position:static} }
.note .sec{background:var(--note-sec);border:1px solid var(--note-sec-line);border-radius:5px;padding:8px 10px}
.note .kv{display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:2px 0;border-bottom:1px dashed var(--note-kv-line)}
.note .kv:last-child{border-bottom:0}
.note .kv span{color:var(--note-kv-key)}
.note .kv b{font-weight:600;color:var(--note-kv-val)}
.note ul{margin:4px 0 0;padding-left:15px;font-size:12px}
.note .full{grid-column:1/-1}
/* ---------- 画面模拟（Stellarium 风格天球） ---------- */
.simwrap{margin-top:2px}
.simcanvas{display:block;width:100%;height:auto;border-radius:6px;background:#03050a;
  border:1px solid rgba(120,95,40,.3);cursor:grab;touch-action:none}
.simcanvas:active{cursor:grabbing}
.simctl{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}
.simctl button,.simopt{padding:3px 9px;font-size:11.5px;background:var(--note-sec);
  color:var(--note-kv-val);border:1px solid var(--note-sec-line);border-radius:6px;cursor:pointer;line-height:1.35}
.simctl button:hover,.simopt:hover{border-color:var(--note-title)}
.simctl button.on,.simopt.on{background:rgba(216,180,106,.3);color:#fff8e2;border-color:rgba(216,180,106,.66)}
.simlab{font-size:11px;color:var(--note-kv-key)}
.simgap{flex:1}
.simrange{flex:1;min-width:64px;height:16px;margin:0;padding:0;align-self:center;accent-color:#8a6d2f;background:transparent}
.simtime{font-size:10.5px;line-height:1.2;color:var(--note-kv-key);white-space:nowrap}
.simchk{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--note-kv-val);cursor:pointer;white-space:nowrap;user-select:none}
.simchk input{width:13px;height:13px;margin:0;accent-color:#8a6d2f;cursor:pointer}
.simcap{font-size:11px;line-height:1.5;margin-top:4px}
/* 推荐度明细比其他便签宽一倍 */
.note .sec.wide{grid-column:span 2}
@media (max-width:900px){ .note .sec.wide{grid-column:auto} }
.bar{display:inline-block;width:64px;height:6px;background:rgba(120,95,40,.25);border-radius:3px;vertical-align:middle;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#8a6d2f,#4f8a3a)}
.dim{color:var(--dim2)}
.err{color:var(--err)}
`;

/* 结果列模板：序号 | 推荐度 | 目标类型 | 目标 | 拍摄地点 | 日期 | 最佳时段（单行所需固定宽） | 最高高度
   共 8 列，除「最佳时段」外其余 7 列等宽平均分配（删除直线距离、天气两列后） */
const GRID = 'repeat(6,minmax(0,1fr)) 220px minmax(0,1fr)';
const ROW = 'display:grid;align-items:center;grid-template-columns:' + GRID;
const PFIELDS = 'display:flex;flex-wrap:nowrap;align-items:flex-end;gap:10px;min-width:0';

const SCRIPT = RENDER_SRC + `
var state = { meta: null, data: null, origin: null, originLabel: '—', open: -1, hereNote: '',
  type: 'any', typeLabel: '不限', typeGroup: null };
var HERE = '@here';
/* ?theme=light|dark 可手动指定配色；不指定时跟随系统（prefers-color-scheme） */
try {
  var forcedTheme = new URLSearchParams(location.search).get('theme');
  if (forcedTheme === 'light' || forcedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', forcedTheme);
  }
} catch (e) { /* 忽略 */ }
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function pad(n){ return n<10?'0'+n:''+n; }
function today(){ var d=new Date(); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function addDays(s,n){ var d=new Date(s+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function fmtDist(km){ if(km===null||km===undefined) return '—'; if(km<1) return '同城'; return km+' km'; }
function cityByName(name){ return (state.meta.cities||[]).filter(function(c){return c.name===name;})[0] || null; }

/* 记住上次定位结果，避免每次打开都弹授权 */
function savedOrigin(){
  try { var raw = localStorage.getItem('ap.origin'); if(!raw) return null;
        var o = JSON.parse(raw);
        return (typeof o.lat==='number' && typeof o.lon==='number') ? o : null; } catch(e){ return null; }
}
function saveOrigin(o){ try { localStorage.setItem('ap.origin', JSON.stringify(o)); } catch(e){} }

/* ---------- 目标类型：两级菜单 ----------
   一级：不限 / 星野 / 日月 / 行星 / 深空（左列）
   二级：该分组下的具体类型（右列，悬停一级即切换）
   选中的值仍写回隐藏 input#type，run() 读值方式不变。 */
function typeGroups(){
  var m = state.meta || {};
  return [{ id: '__any', label: '不限' }].concat(m.eventTypeGroups || []);
}
function typeItems(gid){
  var m = state.meta || {};
  if(gid === '__any') return [{ id: 'any', label: '不限（全部类型）' }];
  return (m.eventTypes || []).filter(function(t){ return t.group === gid; });
}
function typeGroupOf(id){
  var m = state.meta || {};
  var t = (m.eventTypes || []).filter(function(x){ return x.id === id; })[0];
  return t ? t.group : '__any';
}
function typeLabelOf(id){
  if(!id || id === 'any') return '不限';
  var m = state.meta || {};
  var t = (m.eventTypes || []).filter(function(x){ return x.id === id; })[0];
  if(!t) return id;
  var g = (m.eventTypeGroups || []).filter(function(x){ return x.id === t.group; })[0];
  return (g ? g.label + ' · ' : '') + t.label;
}
function renderTypeMenu(){
  var active = state.typeGroup || '__any';
  var left = typeGroups().map(function(g){
    var cls = 'tmenu-item' + (g.id === active ? ' on' : '');
    // 用 data-id + this.dataset 传参，避免在模板里嵌引号
    return '<div class="'+cls+'" data-id="'+esc(g.id)+'" onmouseenter="hoverTypeGroup(this.dataset.id)"'
      + ' onclick="hoverTypeGroup(this.dataset.id)">'
      + '<span>'+esc(g.label)+'</span><span class="tmenu-arrow">›</span></div>';
  }).join('');
  var right = typeItems(active).map(function(t){
    var cls = 'tmenu-item' + (t.id === state.type ? ' on' : '');
    return '<div class="'+cls+'" data-id="'+esc(t.id)+'" onclick="pickType(this.dataset.id)">'+esc(t.label)+'</div>';
  }).join('');
  el('typeMenu').innerHTML = '<div class="tmenu-col">'+left+'</div>'
    + '<div class="tmenu-col tmenu-sub">'+ (right || '<div class="tmenu-item">—</div>') +'</div>';
}
function setType(id){
  state.type = id || 'any';
  state.typeLabel = typeLabelOf(state.type);
  state.typeGroup = state.type === 'any' ? '__any' : typeGroupOf(state.type);
  var hidden = el('type');
  if(hidden) hidden.value = state.type;
  var btn = el('typeBtn');
  if(btn){
    btn.textContent = state.typeLabel;
    if(btn.setAttribute) btn.setAttribute('title', state.typeLabel);
  }
  if(state.meta) renderTypeMenu();
}
function hoverTypeGroup(gid){
  state.typeGroup = gid;
  renderTypeMenu();
}
function pickType(id){
  setType(id);
  hideTypeMenu();
}
function showTypeMenu(){
  state.typeGroup = state.type === 'any' ? '__any' : typeGroupOf(state.type);
  renderTypeMenu();
  el('typeMenu').style.display = 'flex';
}
function hideTypeMenu(){ el('typeMenu').style.display = 'none'; }
function toggleTypeMenu(){
  var box = el('typeMenu');
  if(box.style.display === 'flex') hideTypeMenu();
  else showTypeMenu();
}
function onTypeKey(e){
  if(e && e.key === 'Escape') hideTypeMenu();
}

async function boot(){
  var r = await fetch('/astro-plan/api/meta');
  var m = await r.json();
  state.meta = m;

  // 目标类型：两级菜单（一级分组：不限 / 星野 / 日月 / 行星 / 深空；二级：该组的具体类型）
  setType('any');
  if(document.addEventListener){
    document.addEventListener('click', function(e){
      var box = el('typeMenu');
      if(!box || box.style.display !== 'flex') return;
      var t = e && e.target;
      if(t && t.closest && t.closest('.tmenu-field')) return;
      hideTypeMenu();
    });
    // Esc 关闭目标类型菜单
    document.addEventListener('keydown', function(e){
      if(e && (e.key === 'Escape' || e.key === 'Esc')) hideTypeMenu();
    });
  }

  var reg = el('region');
  var ro = document.createElement('option'); ro.value=''; ro.textContent='全部地区'; reg.appendChild(ro);
  m.regions.forEach(function(x){ var o=document.createElement('option'); o.value=x; o.textContent=x; reg.appendChild(o); });
  fillProvinces();

  var sel = el('originSel');
  var here = document.createElement('option'); here.value=HERE; here.textContent='目前所在地'; sel.appendChild(here);
  m.cities.forEach(function(c){ var o=document.createElement('option'); o.value=c.name; o.textContent=c.name; sel.appendChild(o); });
  var none = document.createElement('option'); none.value=''; none.textContent='不计算距离'; sel.appendChild(none);
  sel.value = HERE;

  el('d1').value = today(); el('d2').value = addDays(today(),6);
  // 第一行小字：数据库更新时间（彗星库每周首次启动自动重建）+ 站点/天气/彗星概况
  var dbUpdated = (m.database && m.database.updatedAtText) || '—';
  state.baseHint = '数据库 '+dbUpdated+' 更新 · 站点库 '+m.stats.total+' 个 · 覆盖 '+m.stats.provinces+' 个省级行政区 · 天气 '+m.weather.from+' ~ '+m.weather.to
    + ' · 彗星 '+m.comets.count+' 颗（视星等 ≤ '+m.comets.maxMag+' 才推荐）';
  el('hint').textContent = state.baseHint;
  await resolveOrigin();
  // 启动时不自动检索：先让用户确认/调整条件，再点「查询」
  el('list').innerHTML = '<div class="meta">设置查询条件后点击「查询」开始检索（默认最低高度角 0°，地平线以上即可参与评估）</div>';
}

function provincesOf(region){
  if(!region) return state.meta.provinces;
  return state.meta.provinces.filter(function(p){ return p.region===region; });
}
function fillProvinces(){
  var region = el('region').value;
  var sel = el('province');
  sel.innerHTML = '';
  var all = document.createElement('option'); all.value=''; all.textContent='全部省份'; sel.appendChild(all);
  provincesOf(region).forEach(function(p){ var o=document.createElement('option'); o.value=p.name; o.textContent=p.name; sel.appendChild(o); });
  fillSites();
}
function fillSites(){
  var region = el('region').value, province = el('province').value;
  var sel = el('site'); sel.innerHTML = '';
  var all = document.createElement('option'); all.value=''; all.textContent='全部具体地点'; sel.appendChild(all);
  var list = state.meta.sites.filter(function(s){
    if(region && s.region!==region) return false;
    if(province && s.province!==province) return false;
    return true;
  }).sort(function(a,b){ return a.bortle-b.bortle; });
  list.forEach(function(s){ var o=document.createElement('option'); o.value=s.id; o.textContent=s.name+'（波特尔 '+s.bortle+'）'; sel.appendChild(o); });
}

/* 出发地点并入顶部提示行：这样正文小字只剩「候选统计 / 点击行展开详情 / 备注」三行 */
function applyOrigin(o, label, note){
  state.origin = o;
  state.originLabel = label;
  state.hereNote = note || '';
  var text = o ? '出发地点：'+label+'（'+o.lat.toFixed(2)+', '+o.lon.toFixed(2)+'）' : '出发地点：不计算直线距离';
  if (note) text += ' · ' + note;
  el('hint').textContent = (state.baseHint ? state.baseHint + ' · ' : '') + text;
}

/* 出发地点下拉 → 解析坐标（目前所在地走浏览器定位，失败则复用上次定位或按北京估算） */
function resolveOrigin(){
  var v = el('originSel').value;
  if(!v){ applyOrigin(null, '不计算距离', ''); return Promise.resolve(); }
  if(v !== HERE){
    var c = cityByName(v);
    if(!c){ applyOrigin(null, '不计算距离', ''); return Promise.resolve(); }
    applyOrigin({ lat: c.lat, lon: c.lon }, c.name, '');
    return Promise.resolve();
  }
  var cached = savedOrigin();
  if(cached){
    applyOrigin(cached, '目前所在地', '按上次定位结果');
    return Promise.resolve();
  }
  return new Promise(function(resolve){
    var fallback = function(msg){
      var bj = cityByName('北京');
      if(bj) applyOrigin({ lat: bj.lat, lon: bj.lon }, '目前所在地', msg);
      else applyOrigin(null, '不计算距离', '');
      resolve();
    };
    if(!navigator.geolocation){ fallback('浏览器不支持定位，按北京估算'); return; }
    navigator.geolocation.getCurrentPosition(function(pos){
      var o = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      saveOrigin(o);
      applyOrigin(o, '目前所在地', '');
      resolve();
    }, function(){ fallback('未获得定位授权，暂按北京估算'); }, { timeout: 6000, maximumAge: 600000, enableHighAccuracy: false });
  });
}

/* 出发地变化：已经查过结果时才重新检索，否则只更新距离基准，不自动发起查询 */
function onOriginChange(){
  resolveOrigin().then(function(){ if(state.data){ run(1); } });
}

function reset(){
  stopAllSims();
  setType('any');
  el('region').value = ''; fillProvinces();
  el('d1').value = today(); el('d2').value = addDays(today(),6);
  el('alt').value = 0; el('bortle').value = 6;
  el('originSel').value = HERE;
  state.data = null; state.open = -1;
  el('stats').textContent = '';
  el('list').innerHTML = '<div class="meta">已恢复默认条件，点击「查询」开始检索</div>';
  resolveOrigin();
}

async function run(page){
  var p = Math.max(1, Math.floor(Number(page)) || 1);
  var btn = el('go'); btn.disabled = true; btn.textContent = '查询中…';
  var q = new URLSearchParams({
    eventType: el('type').value,
    dateStart: el('d1').value, dateEnd: el('d2').value,
    minAltitude: el('alt').value, maxBortle: el('bortle').value,
    page: String(p), pageSize: '20'
  });
  if(el('site').value) q.set('location', el('site').value);
  if(el('province').value) q.set('province', el('province').value);
  if(el('region').value) q.set('region', el('region').value);
  if(state.origin){ q.set('originLat', state.origin.lat); q.set('originLon', state.origin.lon); }
  try {
    var r = await fetch('/astro-plan/api/search?' + q.toString());
    var d = await r.json();
    state.data = d; state.open = -1;
    renderTable(d);
  } catch(e) {
    el('list').innerHTML = '<div class="err">查询失败：'+esc(e.message)+'</div>';
  }
  btn.disabled = false; btn.textContent = '查询';
}

var ROW = '${ROW}';

function cell(cls, html, style){
  return '<div class="'+cls+'" style="'+(style||'')+'">'+html+'</div>';
}

function renderTable(d){
  var host = el('list');
  // 重新渲染前先停掉所有模拟动画，避免定时器堆在已销毁的 canvas 上
  stopAllSims();
  state.open = -1;
  if(!d.ok){
    host.innerHTML = '<div class="err">'+esc(d.message||d.error)+'</div>';
    el('stats').textContent='';
    return;
  }
  // 表格上方只留两行小字：第 1 行在页头（站点库/出发地点），第 2 行就是这里（统计 + 提示 + 备注）
  var summary = '候选 '+d.poolSize.candidates+' 条 · 评估站点 '+d.poolSize.sites+' 个 · 结果按推荐度排序，点击行展开详情';
  if(d.notes && d.notes.length) summary += ' ｜ ' + d.notes.join(' ｜ ');
  el('stats').textContent = summary;

  var head = ['#','推荐度','目标类型','目标','拍摄地点','日期','最佳时段','最高高度']
    .map(function(t){ return cell('hcell', esc(t)); }).join('');

  var rows = d.ranked.map(function(x,i){
    return '<div class="rrow ritem" id="row'+i+'" style="'+ROW+'" onclick="toggle('+i+')">'
      + cell('rank', String(x.rank))
      + cell('sc', String(x.score))
      + cell('c-type', esc(x.target.typeLabel))
      + cell('c-target', esc(x.target.name))
      + cell('c-site', '<span>'+esc(x.site.name)+'</span><span class="cell-sub">'+esc(x.site.province)+' · 波特尔 '+x.site.bortle+'</span>')
      + cell('c-date', esc(x.date))
      + cell('c-window', esc(x.window.startShort)+' → '+esc(x.window.endShort))
      + cell('c-alt', x.geometry.altMax+'° '+esc(x.geometry.directionAtMax || x.geometry.direction))
      + '</div>'
      + '<div class="detail" id="det'+i+'"><div>'+note(x, i)+'</div></div>';
  }).join('');

  host.innerHTML = '<div class="tablewrap"><div class="reswrap">'
    + '<div class="rrow rhead" style="'+ROW+'">'+head+'</div>'
    + rows + '</div></div>'
    + pager(d);
}

/* 分页条：共 N 条，20 条/页，带页码跳转 */
function pager(d){
  var p = d.pagination;
  if(!p) return '';
  var jump = '<span style="display:flex;gap:6px;align-items:center">'
    + '<input id="pageInput" class="w-page" type="number" min="1" max="'+p.totalPages+'" value="'+p.page+'"'
    + ' onkeydown="if(event.keyCode===13){jumpPage()}">'
    + '<button class="ghost" onclick="jumpPage()">跳转</button></span>';
  if(p.totalPages <= 1) return '<div class="pager"><span>共 '+p.total+' 条</span>'+jump+'</div>';
  return '<div class="pager">'
    + '<button class="ghost" '+(p.page<=1?'disabled':'')+' onclick="gotoPage('+(p.page-1)+')">上一页</button>'
    + '<span>第 '+p.page+' / '+p.totalPages+' 页 · 共 '+p.total+' 条</span>'
    + '<button class="ghost" '+(p.page>=p.totalPages?'disabled':'')+' onclick="gotoPage('+(p.page+1)+')">下一页</button>'
    + jump
    + '</div>';
}

function jumpPage(){
  var node = el('pageInput');
  var v = Math.floor(Number(node && node.value));
  if(!v || v < 1) return;
  gotoPage(v);
}

function gotoPage(n){
  run(n);
  var list = el('list');
  if(list && list.scrollIntoView) list.scrollIntoView({block:'start'});
}

function kv(k,v){ return '<div class="kv"><span>'+esc(k)+'</span><b>'+esc(v)+'</b></div>'; }

/* 最高高度带上「最高点那一刻」的方位：45°（东南 135°） */
function altMaxText(g){
  var dir = g.directionAtMax || g.direction || '';
  var az = (g.azMax===null || g.azMax===undefined) ? '' : ' '+g.azMax+'°';
  return g.altMax+'°（'+dir+az+'）';
}

/* 坐标用经纬度表述：北纬 40.50° · 东经 115.83° */
function latLonText(lat, lon){
  var ns = lat >= 0 ? '北纬' : '南纬';
  var ew = lon >= 0 ? '东经' : '西经';
  return ns+' '+Math.abs(lat).toFixed(2)+'° · '+ew+' '+Math.abs(lon).toFixed(2)+'°';
}

/* 曝光：行星/日月/极光的曝光不是整数秒，数据里已给好文案 */
function exposureTextOf(p){
  return p.exposureText || (p.exposureSec+' s × '+p.frames+' 张');
}

/* 曝光依据：规划层按题材选公式（500 法则 / Looney 11 / 巴德膜 / 极光经验值 / 赤道仪），这里只负责显示 */
function exposureHint(p){
  return p.hint || '';
}

function gradeRow(name, score, text){
  var barHtml = score==null ? '<span class="dim" style="font-size:11px">无</span>' : '<span class="bar"><i style="width:'+score+'%"></i></span>';
  return '<div style="display:grid;grid-template-columns:40px 66px 30px 1fr;gap:8px;align-items:center;'
    + 'padding:3px 0;border-bottom:1px dashed var(--note-kv-line)">'
    + '<span style="color:var(--note-kv-key);font-size:11.5px">'+esc(name)+'</span>'
    + barHtml
    + '<b style="font-size:11.5px;text-align:right">'+(score==null?'—':score)+'</b>'
    + '<span style="font-size:11.5px;color:var(--note-kv-val);white-space:normal">'+esc(text||'')+'</span>'
    + '</div>';
}

/* 便签分区的固定顺序：目标、时间与月相、地点、距离与行程、方位与构图、画面模拟、拍摄参数、天气、推荐度明细与推荐理由 */
function note(x, i){
  var w = x.weather || {status:'none'};
  var rd = x.reasonDetail || {};
  var weatherHtml = w.score!=null
    ? kv('综合评分', w.score+' 分')+kv('平均云量', w.cloudMean+'%')+kv('晴夜小时', w.clearHours+' h')
      +kv('最佳 3h 窗口', w.best3Start+' 起 / 云 '+w.best3Cloud+'%')+kv('降水概率峰值', w.precipMax+'%')
      +kv('最低温', w.tMin+' ℃')+kv('露点差', w.dewGap+' ℃')+kv('最大风速', w.windMax+' km/h')+kv('能见度', w.visKm+' km')
    : '<div class="dim">'+esc(w.status==='out_of_range'?'该日期超出 7 天预报范围，仅按天文条件评估':'天气数据不可用')+'</div>';
  var fg = x.foreground || {};
  var fgLevel = (fg.irreplaceability||0) >= 70 ? '高' : ((fg.irreplaceability||0) >= 40 ? '中' : '低');

  return '<div class="note"><div class="notegrid"><div class="noteleft">'
    + '<div class="sec"><h5>目标</h5>'
      + kv('名称', x.target.name)+kv('类型', x.target.typeLabel)+kv('最低波特尔', x.target.minBortle)
      + (x.target.separation!=null ? kv('角距', x.target.separation+'°') : '')
      + (x.target.mag!=null
        ? kv('视星等', x.target.mag+' 等')+kv('距日角', x.target.elongation+'°')
          + kv('距地距离', x.target.deltaAu+' AU')+kv('日心距', x.target.rAu+' AU')
        : '')
      + '<div class="dim" style="font-size:12px;margin-top:6px">'+esc(x.target.tips||'')+'</div></div>'
    + '<div class="sec"><h5>时间与月相</h5>'
      + kv('日期', x.date)+kv('可见窗口', x.window.startShort+' – '+x.window.endShort)
      + kv('可用时长', x.window.hours+' h')+kv('月照度', x.window.moon.illum+'%（'+x.window.moon.phase+'）')+'</div>'
    + '<div class="sec"><h5>地点</h5>'
      + kv('地区', x.site.region+' · '+x.site.province)+kv('具体地点', x.site.name)
      + kv('直线距离', x.distanceKm != null ? fmtDist(x.distanceKm) : '—')
      + kv('出发地', state.originLabel||'—')
      + kv('波特尔指数', 'B'+x.site.bortle)+kv('海拔', x.site.altM+' m')
      + kv('坐标', latLonText(x.site.lat, x.site.lon))+'</div>'
    + '<div class="sec"><h5>方位与构图</h5>'
      + kv('方向', x.geometry.direction)+kv('方位角', x.geometry.azStart+'° → '+x.geometry.azEnd+'°')
      + kv('最高高度', altMaxText(x.geometry))
      + kv('地景', fg.name||'自选前景')+kv('不可替代性', fg.name ? fgLevel+'（全国 '+(fg.sharedBy||1)+' 站）' : '低')+'</div>'
    + '<div class="sec"><h5>拍摄参数</h5>'
      + kv('全画幅焦段', x.params.ffFocal)+kv('APS-C 焦段', x.params.apsFocal)+kv('光圈', x.params.aperture)
      + kv('曝光', exposureTextOf(x.params))+kv('ISO', x.params.iso)
      + kv('赤道仪', x.params.trackerRequired ? '必须使用' : (x.params.trackerNeeded?'建议使用':'可不用'))
      + (exposureHint(x.params) ? '<div class="dim" style="font-size:11px;margin-top:4px">'+esc(exposureHint(x.params))+'</div>' : '')+'</div>'
    + '<div class="sec"><h5>天气（'+(w.status==='ok'?'Open-Meteo 逐时':'—')+'）</h5>'+weatherHtml+'</div>'
      + '<div class="sec wide"><h5>推荐度明细与推荐理由（总分 '+x.score
        + ((x.breakdown && x.breakdown.participating && x.breakdown.participating < 5)
          ? '，按 '+x.breakdown.participating+' 个维度换算为百分制' : '')+'）</h5>'
        + gradeRows(x)
        + '</div>'
    + '</div>'
    + '<div class="noteright"><div class="sec"><h5>画面模拟（最佳时段）</h5>'+simBlock(x.sim, i)+'</div></div>'
    + '</div></div>';
}

/* 五个评分维度；日食会忽略「光污染」「月相」（breakdown.ignored） */
var DIMS = [['天象','sky'],['光污染','pollution'],['月相','moon'],['天气','weather'],['地景','foreground']];
function gradeRows(x){
  var b = x.breakdown || {}, rd = x.reasonDetail || {}, ignored = b.ignored || [];
  return DIMS.filter(function(d){ return ignored.indexOf(d[1]) < 0; })
    .map(function(d){ return gradeRow(d[0], b[d[1]], rd[d[1]]); }).join('');
}

/* ---------- 画面模拟：3D 天球（Stellarium 风格） ----------
   星表/星座/黄道/银河在 meta.sky，逐帧数据在 ranked[i].sim；
   这里只负责播放、缩放、坐标系、放大浮层与调用共用的 skyRender（源码来自 lib/skyview.js）。 */
var sims = {};
function simSky(){
  return (state.meta && state.meta.sky) || { stars: [], lines: [], ecliptic: [] };
}
function simData(i){
  var row = state.data && state.data.ranked ? state.data.ranked[i] : null;
  return row && row.sim ? row.sim : null;
}
function stopSim(i){
  var s = sims[i];
  if(s && s.timer) clearInterval(s.timer);
  if(s) delete sims[i];
}
function stopAllSims(){
  Object.keys(sims).forEach(function(k){ stopSim(Number(k)); });
}
function drawCanvas(canvas, s){
  if(!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  skyRender(ctx, {
    sim: s.sim,
    sky: simSky(),
    camera: { yaw: s.cam.yaw, pitch: s.cam.pitch, fov: s.cam.fov, tracker: s.track },
    free: Boolean(s.cam.free),
    mode: s.mode,
    w: canvas.width,
    h: canvas.height
  }, s.k);
}
function drawSimAt(i){
  var s = sims[i];
  if(!s) return;
  drawCanvas(el('sim'+i), s);
}
function setText(id, text){
  var node = el(id);
  if(node) node.textContent = text;
}
function setRange(id, value){
  var node = el(id);
  if(node) node.value = String(value);
}
function setOn(id, on){
  var node = el(id);
  if(node && node.classList) node.classList[on ? 'add' : 'remove']('on');
}
function syncSimUI(i){
  var s = sims[i];
  if(!s) return;
  var playing = s.playing;
  setText('simbtn'+i, playing ? '暂停' : '播放');
  setText('bigbtn'+i, playing ? '暂停' : '播放');
  setRange('simrange'+i, s.k);
  setRange('bigrange'+i, s.k);
  setText('simfov'+i, Math.round(s.cam.fov)+'°');
  setText('bigfov'+i, Math.round(s.cam.fov)+'°');
  setOn('modealt'+i, s.mode !== 'eq');
  setOn('modeeq'+i, s.mode === 'eq');
  setOn('modealtbig'+i, s.mode !== 'eq');
  setOn('modeeqbig'+i, s.mode === 'eq');
  var cb = el('track'+i);
  if(cb) cb.checked = Boolean(s.track);
}
function simTick(i){
  var s = sims[i];
  if(!s || !s.playing) return;
  s.k = (s.k + 1) % s.sim.frames.length;
  setRange('simrange'+i, s.k);
  setRange('bigrange'+i, s.k);
  drawSimAt(i);
}
function startTimer(i){
  var s = sims[i];
  if(!s) return;
  if(s.timer) clearInterval(s.timer);
  s.timer = setInterval(function(){ simTick(i); }, 140);
}
function openSim(i){
  stopSim(i);
  var sim = simData(i);
  if(!sim || sim.skip || !sim.frames || !sim.frames.length) return;
  var canvas = el('sim'+i);
  // 测试用的假 DOM 没有 canvas 2D 上下文：直接跳过
  if(!canvas || !canvas.getContext) return;
  var s = {
    sim: sim,
    k: Math.max(0, sim.startIndex || 0),
    playing: false,
    timer: null,
    big: false,
    mode: 'altaz',
    track: Boolean(sim.camera && sim.camera.tracker),
    cam: { yaw: sim.camera.yaw, pitch: sim.camera.pitch, fov: sim.camera.fov || 100, free: false },
    drag: null
  };
  sims[i] = s;
  fitSimCanvas(i);
  // 滚轮缩放：必须非 passive 才能 preventDefault 阻止页面滚动
  if(canvas.addEventListener){
    canvas.addEventListener('wheel', function(e){ simWheel(e, i); }, { passive: false });
  }
  syncSimUI(i);
  drawSimAt(i);
}
/* 画布位图尺寸跟显示尺寸一致（按 DPR 放大）：固定 960×540 靠 CSS 拉伸到 ~1250 px 时，
   浏览器非整数倍放大会重复部分列，平滑渐变区出现竖纹（180° 视场最明显）。 */
function fitSimCanvas(i){
  var c = el('sim'+i);
  if(!c || typeof c.getBoundingClientRect !== 'function') return;
  var rect = c.getBoundingClientRect && c.getBoundingClientRect();
  var cssW = (rect && rect.width) || c.clientWidth || 0;
  if(!cssW) return;
  var dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  var w = Math.round(Math.min(1680, cssW * dpr));
  var h = Math.round(w * 9 / 16);
  if(c.width !== w || c.height !== h){ c.width = w; c.height = h; }
}
function toggleSim(i){
  var s = sims[i];
  if(!s){ openSim(i); return; }
  s.playing = !s.playing;
  if(s.playing) startTimer(i);
  syncSimUI(i);
  drawSimAt(i);
}
// 窗口尺寸变化：重排已打开的画布位图并重画，避免拉伸放大
if(typeof window !== 'undefined' && window.addEventListener){
  window.addEventListener('resize', function(){
    for(var ri = 0; ri < sims.length; ri += 1){
      if(sims[ri]){ fitSimCanvas(ri); drawSimAt(ri); }
    }
  });
}
function seekSim(i, v){  var s = sims[i];
  if(!s) return;
  var k = Math.floor(Number(v));
  if(!(k >= 0)) k = 0;
  if(k > s.sim.frames.length - 1) k = s.sim.frames.length - 1;
  s.k = k;
  s.playing = false;
  syncSimUI(i);
  drawSimAt(i);
}
function simWheel(e, i){
  var s = sims[i];
  if(!s) return;
  if(e && e.preventDefault) e.preventDefault();
  var dy = (e && e.deltaY) || 0;
  if(!dy) return;
  // 只改视场，不动 free：跟随时继续跟、固定机位保持当前方向（不再甩到默认机位）
  s.cam.fov = Math.max(5, Math.min(180, s.cam.fov * Math.exp(dy * 0.0015)));
  syncSimUI(i);
  drawSimAt(i);
}
function zoomSim(i, dir){
  var s = sims[i];
  if(!s) return;
  // dir > 0 = 放大（视野变小），dir < 0 = 缩小
  s.cam.fov = Math.max(5, Math.min(180, s.cam.fov * (dir > 0 ? 1 / 1.3 : 1.3)));
  syncSimUI(i);
  drawSimAt(i);
}
function toggleTrack(i, on){
  var s = sims[i];
  if(!s) return;
  if(on){
    s.track = true;
    s.cam.free = false;
  } else {
    // 取消跟随：保持当前画面方向（当前帧的目标方向），不要跳回默认机位
    var cur = skyTpCenter(s.sim.frames[s.k] && s.sim.frames[s.k].tp);
    s.track = false;
    if(cur){ s.cam.yaw = cur.az; s.cam.pitch = Math.max(0, Math.min(90, cur.alt)); }
    s.cam.free = true;
  }
  syncSimUI(i);
  drawSimAt(i);
}
function setMode(i, mode){
  var s = sims[i];
  if(!s) return;
  s.mode = mode === 'eq' ? 'eq' : 'altaz';
  syncSimUI(i);
  drawSimAt(i);
}
/* 拖拽转视角；没拖动就当作点击 → 放大查看 */
function simDown(e, i){
  var s = sims[i];
  if(!s) return;
  s.drag = { x: e.clientX, y: e.clientY, yaw: s.cam.yaw, pitch: s.cam.pitch, moved: false };
}
function simMove(e, i){
  var s = sims[i];
  if(!s || !s.drag) return;
  var dx = e.clientX - s.drag.x;
  var dy = e.clientY - s.drag.y;
  if(Math.abs(dx) + Math.abs(dy) > 4) s.drag.moved = true;
  var cw = (el('cv'+i) && el('cv'+i).width) || 960;
  var perPx = (s.cam.fov || 100) / (cw * 0.9);
  // 手动转视角 = 退出跟随
  if(Math.abs(dx) + Math.abs(dy) > 4 && s.track) { s.track = false; syncSimUI(i); }
  s.cam.yaw = ((s.drag.yaw - dx * perPx) % 360 + 360) % 360;
  s.cam.pitch = Math.max(0, Math.min(90, s.drag.pitch + dy * perPx));
  s.cam.free = true;
  drawSimAt(i);
}
function simUp(e, i){
  var s = sims[i];
  if(!s || !s.drag) return;
  s.drag = null;
}
function simReset(i){
  var s = sims[i];
  if(!s) return;
  // 恢复成刚打开时的样子：默认视角 + 最佳时段开始那一帧 + 不播放 + 地平坐标 + 默认跟踪
  if(s.timer){ clearInterval(s.timer); s.timer = null; }
  s.playing = false;
  s.k = Math.max(0, s.sim.startIndex || 0);
  s.mode = 'altaz';
  s.track = Boolean(s.sim.camera && s.sim.camera.tracker);
  s.cam = { yaw: s.sim.camera.yaw, pitch: s.sim.camera.pitch, fov: s.sim.camera.fov || 100, free: false };
  syncSimUI(i);
  drawSimAt(i);
}
/* 便签右列的画面模拟卡片：960×540 画布 + 播放 / 缩放 / 坐标系 */
function simBlock(sim, i){
  if(!sim) return '<div class="dim" style="font-size:11.5px">本次查询不含画面模拟（withSim 未开启）</div>';
  if(sim.skip === 'aurora') return '<div class="dim" style="font-size:11.5px">极光没有固定方位，不做画面模拟；按北向地景与 Kp 预报安排即可</div>';
  if(!sim.frames || !sim.frames.length) return '<div class="dim" style="font-size:11.5px">画面模拟数据为空</div>';
  var first = sim.frames[0];
  var last = sim.frames[sim.frames.length-1];
  return '<div class="simwrap">'
    + '<canvas id="sim'+i+'" class="simcanvas" width="960" height="540"'
      + ' onmousedown="simDown(event,'+i+')" onmousemove="simMove(event,'+i+')"'
      + ' onmouseup="simUp(event,'+i+')" onmouseleave="simUp(event,'+i+')"'
      + ' ondblclick="simReset('+i+')" title="滚轮缩放 · 拖动转视角"></canvas>'
    + '<div class="simctl">'
      + '<button type="button" id="simbtn'+i+'" class="simopt" onclick="toggleSim('+i+')">播放</button>'
      + '<input id="simrange'+i+'" class="simrange" type="range" min="0" max="'+(sim.frames.length-1)+'" value="'+(sim.startIndex||0)+'"'
        + ' oninput="seekSim('+i+',this.value)">'
      + '<label class="simchk" title="勾上=相机跟着目标走；取消=固定机位"><input type="checkbox" id="track'+i+'"'
        + (sim.camera && sim.camera.tracker ? ' checked' : '') + ' onchange="toggleTrack('+i+',this.checked)"> 跟踪</label>'
      + '<span class="simtime">'+esc(first.d)+' '+esc(first.t)+' → '+esc(last.d)+' '+esc(last.t)+'</span>'
    + '</div>'
    + '<div class="simctl">'
      + '<span class="simlab">坐标系</span>'
      + '<button type="button" id="modealt'+i+'" class="simopt on" onclick="setMode('+i+',&quot;altaz&quot;)">地平</button>'
      + '<button type="button" id="modeeq'+i+'" class="simopt" onclick="setMode('+i+',&quot;eq&quot;)">赤道</button>'
      + '<span class="simgap"></span>'
      + '<button type="button" class="simopt" onclick="zoomSim('+i+',-1)">−</button>'
      + '<span id="simfov'+i+'" class="simlab">'+(sim.camera.fov||100)+'°</span>'
      + '<button type="button" class="simopt" onclick="zoomSim('+i+',1)">＋</button>'
      + '<button type="button" class="simopt" onclick="simReset('+i+')">重置</button>'
    + '</div>'
    + '<div class="simcap dim">'+esc(sim.caption)+' · 最佳时段 '+esc(sim.window.start)+'–'+esc(sim.window.end)
      + ' · 滚轮缩放 · 拖动转视角</div>'
  + '</div>';
}

function toggle(i){
  var d = el('det'+i), r = el('row'+i);
  var showing = d.classList.contains('open');
  if(state.open>=0 && state.open!==i){
    el('det'+state.open).classList.remove('open');
    el('row'+state.open).classList.remove('open');
    stopSim(state.open);
  }
  // 过渡由 CSS 的 grid-template-rows 0fr ↔ 1fr 完成，内容一直在 DOM 里，收起也能收干净
  d.classList.toggle('open', !showing);
  r.classList.toggle('open', !showing);
  state.open = showing ? -1 : i;
  if(showing) stopSim(i);
  else openSim(i);
}

boot();
`;

const P = `style="${PFIELDS}"`;

export function page() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>星野计划 · by Sirius YANG</title>
<style>${CSS}</style></head>
<body>
<header>
  <h1>星野计划 <small>by Sirius YANG</small></h1>
  <div class="sub" id="hint">加载中…</div>
</header>
<div class="wrap">
  <div class="panel">
    <div class="prow">
      <div class="plabel">拍摄日期</div>
      <div class="pfields" ${P}>
        <div class="field"><label>开始日期</label><input id="d1" class="w-date" type="date"></div>
        <div class="field"><label>结束日期</label><input id="d2" class="w-date" type="date"></div>
      </div>
    </div>
    <div class="prow">
      <div class="plabel">目的地及出发地</div>
      <div class="pfields" ${P}>
        <div class="field"><label>目标地区</label><select id="region" class="w-region" onchange="fillProvinces()"></select></div>
        <div class="field"><label>目标省份</label><select id="province" class="w-province" onchange="fillSites()"></select></div>
        <div class="field"><label>目标地点</label><select id="site" class="w-site"></select></div>
        <div class="field"><label>出发地点</label><select id="originSel" class="w-origin" onchange="onOriginChange()"></select></div>
      </div>
    </div>
    <div class="prow">
      <div class="plabel">拍摄目标</div>
      <div class="pfields" ${P}>
        <div class="field tmenu-field"><label>目标类型</label>
          <button id="typeBtn" class="tbtn" type="button" onclick="toggleTypeMenu()" onkeydown="onTypeKey(event)">不限</button>
          <div id="typeMenu" class="tmenu" style="display:none"></div>
          <input id="type" type="hidden" value="any">
        </div>
        <div class="field"><label>高度角≥</label><input id="alt" class="w-alt" type="number" value="0" min="0" max="80"></div>
        <div class="field"><label>波特尔指数（光污染）≤</label><input id="bortle" class="w-bortle" type="number" value="6" min="1" max="9"></div>
      </div>
    </div>
    <div class="pactions">
      <button id="go" onclick="run()">查询</button>
      <button class="ghost" onclick="reset()">重置</button>
    </div>
  </div>
  <div class="meta" id="stats"></div>
  <div id="list"></div>
</div>
<script>${SCRIPT}</script>
</body></html>`
}
