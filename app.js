/* Liqstorm Dienstplan: photo roster recognition + editable personal shift calendar.
   Everything is stored locally in this browser (localStorage). */

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.127.0/+esm';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
const STORE_KEY = 'liqstorm.dienstplan.v1';

const MONTHS = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const DOW = ['Mo','Di','Mi','Do','Fr','Sa','So'];
const DOW_LONG = ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'];

const DEFAULT_CODES = [
  {code:'F', label:'Frühdienst',  start:'06:00', end:'14:00', color:'#38bdf8', kind:'work'},
  {code:'S', label:'Spätdienst',  start:'14:00', end:'22:00', color:'#ffc94d', kind:'work'},
  {code:'N', label:'Nachtdienst', start:'22:00', end:'06:00', color:'#a78bfa', kind:'work'},
  {code:'T', label:'Tagdienst',   start:'08:00', end:'16:30', color:'#34d399', kind:'work'},
  {code:'X', label:'Frei',        start:'',      end:'',      color:'#64748b', kind:'off'},
  {code:'U', label:'Urlaub',      start:'',      end:'',      color:'#fb923c', kind:'off'},
  {code:'K', label:'Krank',       start:'',      end:'',      color:'#f43f5e', kind:'off'},
];

/* ---------- state ---------- */
const state = load();
const now = new Date();
let viewY = now.getFullYear(), viewM = now.getMonth();
let photos = [];          // {id, name, dataUrl, base64, mediaType}
let scanResult = null;    // {year, month, entries:{day:{code,start,end,uncertain}}, notes}
let editKey = null, editCode = '';

function load(){
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch {}
  s = s && typeof s === 'object' ? s : {};
  return {
    settings: Object.assign({name:'', apiKey:'', model:'claude-opus-5-5', mode:'claude'}, s.settings || {}),
    codes: Array.isArray(s.codes) && s.codes.length ? s.codes : DEFAULT_CODES.map(c => ({...c})),
    days: s.days && typeof s.days === 'object' ? s.days : {},
  };
}
function save(){
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch { toast('Speichern fehlgeschlagen: Speicher des Browsers voll oder gesperrt.'); }
}

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
const dowIdx = (y, m, d) => (new Date(y, m, d).getDay() + 6) % 7; // Monday = 0
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const codeDef = code => state.codes.find(c => c.code.toLowerCase() === String(code || '').toLowerCase());
const colorOf = code => codeDef(code)?.color || '#94a3b8';
const isTime = t => /^\d{2}:\d{2}$/.test(t || '');

function toast(msg, ms = 2600){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/** effective start/end of a stored day entry (override or code default) */
function timesOf(entry){
  const def = codeDef(entry.code) || {};
  return { start: entry.start || def.start || '', end: entry.end || def.end || '' };
}
function hoursOf(entry){
  const def = codeDef(entry.code);
  if (def && def.kind === 'off') return 0;
  const {start, end} = timesOf(entry);
  if (!isTime(start) || !isTime(end)) return 0;
  const [a, b] = [start, end].map(t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
  let d = b - a; if (d <= 0) d += 24 * 60;
  return d / 60;
}
const fmtH = h => (Math.round(h * 100) / 100).toLocaleString('de-DE', {maximumFractionDigits: 2});

/* ---------- navigation ---------- */
function show(view){
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + view));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === view));
  if (view === 'plan') renderPlan();
  if (view === 'codes') renderCodes();
  if (view === 'settings') renderSettings();
  if (view === 'scan') renderScanForm();
  scrollTo({top: 0, behavior: 'smooth'});
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.view)));

function renderModePill(){
  const p = $('#modePill'), s = state.settings;
  if (s.mode === 'claude' && s.apiKey){ p.textContent = 'KI aktiv'; p.className = 'pill ok'; }
  else if (s.mode === 'claude'){ p.textContent = 'Kein API-Schlüssel'; p.className = 'pill'; }
  else { p.textContent = 'Offline-Modus'; p.className = 'pill warn'; }
}

/* ---------- plan view ---------- */
function renderPlan(){
  $('#monthTitle').innerHTML = `${MONTHS[viewM]}<small>${viewY}</small>`;
  const n = daysIn(viewY, viewM), first = dowIdx(viewY, viewM, 1);
  const todayKey = keyOf(now.getFullYear(), now.getMonth(), now.getDate());
  let html = DOW.map((d, i) => `<div class="dow${i > 4 ? ' we' : ''}">${d}</div>`).join('');
  for (let i = 0; i < first; i++) html += '<div class="day pad"></div>';
  let hours = 0, work = 0, off = 0, absent = 0;
  const used = new Set();
  for (let d = 1; d <= n; d++){
    const k = keyOf(viewY, viewM, d), e = state.days[k], wi = dowIdx(viewY, viewM, d);
    let inner = `<span class="n">${d}</span>`, style = '';
    if (e && e.code){
      const def = codeDef(e.code), c = colorOf(e.code), {start, end} = timesOf(e);
      used.add(e.code);
      style = `style="--c:${c}"`;
      inner += `<span class="code" style="--c:${c}">${esc(e.code)}</span>`;
      if (isTime(start) && isTime(end) && (!def || def.kind !== 'off')) inner += `<span class="t">${start}–${end}</span>`;
      else if (def) inner += `<span class="t">${esc(def.label)}</span>`;
      const h = hoursOf(e); hours += h;
      if (h > 0) work++;
      else if (def && def.kind === 'off' && /^x$|frei/i.test(def.code + ' ' + def.label)) off++;
      else if (def && def.kind === 'off') absent++;
      if (e.note) inner += '<i class="flag note"></i>';
      if (e.src === 'manual') inner += '<i class="flag edit" title="von Hand geändert"></i>';
    }
    html += `<button class="day${wi > 4 ? ' we' : ''}${k === todayKey ? ' today' : ''}" data-k="${k}" ${style} aria-label="${d}. ${MONTHS[viewM]}${e && e.code ? ', ' + esc(e.code) : ''}">${inner}</button>`;
  }
  $('#cal').innerHTML = html;
  $('#cal').querySelectorAll('.day[data-k]').forEach(b => b.addEventListener('click', () => openEditor(b.dataset.k)));

  $('#stats').innerHTML = `
    <div class="stat h"><b>${fmtH(hours)}</b><small>Stunden</small></div>
    <div class="stat w"><b>${work}</b><small>Dienste</small></div>
    <div class="stat o"><b>${off}</b><small>Frei</small></div>
    <div class="stat u"><b>${absent}</b><small>Urlaub / Krank</small></div>`;

  $('#legend').innerHTML = state.codes.filter(c => used.has(c.code))
    .map(c => `<span style="--c:${c.color}"><i></i>${esc(c.code)} · ${esc(c.label)}</span>`).join('');

  renderUpcoming();
}

function renderUpcoming(){
  const today = keyOf(now.getFullYear(), now.getMonth(), now.getDate());
  const items = Object.keys(state.days).filter(k => k >= today && state.days[k]?.code).sort().slice(0, 6);
  if (!items.length){
    $('#upcoming').innerHTML = `<li class="empty" style="display:block;border:0"><b>Noch keine Dienste</b>Scanne deinen Plan oder tippe auf einen Tag im Kalender.</li>`;
    return;
  }
  $('#upcoming').innerHTML = items.map(k => {
    const e = state.days[k], [y, m, d] = k.split('-').map(Number), def = codeDef(e.code), {start, end} = timesOf(e);
    const wd = DOW[dowIdx(y, m - 1, d)], label = def ? def.label : 'Unbekannt';
    const time = isTime(start) && isTime(end) && def?.kind !== 'off' ? `${start} – ${end}` : '';
    return `<li><span class="d">${pad(d)}.${pad(m)}.<small>${k === today ? 'HEUTE' : wd.toUpperCase()}</small></span>
      <span class="c" style="--c:${colorOf(e.code)}">${esc(e.code)}</span>
      <span class="l">${esc(label)}${time ? ` · ${time}` : ''}${e.note ? `<small>${esc(e.note)}</small>` : ''}</span></li>`;
  }).join('');
}

$('#prevM').addEventListener('click', () => { if (--viewM < 0){ viewM = 11; viewY--; } renderPlan(); });
$('#nextM').addEventListener('click', () => { if (++viewM > 11){ viewM = 0; viewY++; } renderPlan(); });
$('#todayBtn').addEventListener('click', () => { viewY = now.getFullYear(); viewM = now.getMonth(); renderPlan(); });

/* swipe between months on touch devices */
(() => {
  let x0 = null, y0 = null;
  const cal = $('#cal');
  cal.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, {passive: true});
  cal.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? $('#nextM') : $('#prevM')).click();
  });
})();

/* ---------- day editor ---------- */
function openEditor(k){
  editKey = k;
  const [y, m, d] = k.split('-').map(Number), e = state.days[k] || {};
  editCode = e.code || '';
  $('#sheetDow').textContent = DOW_LONG[dowIdx(y, m - 1, d)];
  $('#sheetTitle').textContent = `${d}. ${MONTHS[m - 1]} ${y}`;
  $('#edNote').value = e.note || '';
  renderCodePick();
  const t = timesOf(e); $('#edStart').value = t.start; $('#edEnd').value = t.end;
  $('#sheet').classList.add('open');
}
function renderCodePick(){
  $('#codepick').innerHTML = state.codes.map(c =>
    `<button type="button" data-c="${esc(c.code)}" class="${c.code === editCode ? 'on' : ''}" style="--c:${c.color}">${esc(c.code)}<small>${esc(c.label)}</small></button>`).join('');
  $('#codepick').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    editCode = b.dataset.c;
    const def = codeDef(editCode);
    $('#edStart').value = def?.start || ''; $('#edEnd').value = def?.end || '';
    renderCodePick();
  }));
}
function closeEditor(){ $('#sheet').classList.remove('open'); editKey = null; }
$('#sheetClose').addEventListener('click', closeEditor);
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeEditor(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && $('#sheet').classList.contains('open')) closeEditor(); });
$('#edSave').addEventListener('click', () => {
  const note = $('#edNote').value.trim();
  if (!editCode && !note){ delete state.days[editKey]; }
  else {
    const def = codeDef(editCode), s = $('#edStart').value, en = $('#edEnd').value;
    const entry = {code: editCode, src: 'manual'};
    if (s && s !== (def?.start || '')) entry.start = s;
    if (en && en !== (def?.end || '')) entry.end = en;
    if (note) entry.note = note;
    state.days[editKey] = entry;
  }
  save(); closeEditor(); renderPlan(); toast('Gespeichert');
});
$('#edClear').addEventListener('click', () => { delete state.days[editKey]; save(); closeEditor(); renderPlan(); toast('Eintrag gelöscht'); });

/* ---------- codes view ---------- */
function renderCodes(){
  $('#codes').innerHTML = state.codes.map((c, i) => `
    <div class="cd" data-i="${i}" style="--c:${c.color}">
      <input type="color" class="c-col" value="${esc(c.color)}" aria-label="Farbe">
      <input type="text" class="k c-key" value="${esc(c.code)}" maxlength="6" aria-label="Kürzel">
      <input type="text" class="c-label" value="${esc(c.label)}" aria-label="Bezeichnung">
      <input type="time" class="c-s" value="${esc(c.start)}" aria-label="Beginn">
      <input type="time" class="c-e" value="${esc(c.end)}" aria-label="Ende">
      <select class="c-kind" aria-label="Art"><option value="work"${c.kind !== 'off' ? ' selected' : ''}>Dienst</option><option value="off"${c.kind === 'off' ? ' selected' : ''}>Abwesend</option></select>
      <button class="rm" type="button" aria-label="Entfernen">✕</button>
    </div>`).join('');
  $('#codes').querySelectorAll('.cd').forEach(row => {
    row.querySelector('.c-col').addEventListener('input', e => row.style.setProperty('--c', e.target.value));
    row.querySelector('.rm').addEventListener('click', () => { readCodes(); state.codes.splice(+row.dataset.i, 1); renderCodes(); });
  });
}
function readCodes(){
  state.codes = [...$('#codes').querySelectorAll('.cd')].map(r => {
    const start = r.querySelector('.c-s').value, end = r.querySelector('.c-e').value;
    return {
      code: r.querySelector('.c-key').value.trim(),
      label: r.querySelector('.c-label').value.trim() || r.querySelector('.c-key').value.trim(),
      start, end, color: r.querySelector('.c-col').value,
      kind: r.querySelector('.c-kind').value,
    };
  }).filter(c => c.code);
}
$('#addCode').addEventListener('click', () => {
  readCodes();
  state.codes.push({code:'', label:'', start:'', end:'', color:'#94a3b8', kind:'work'});
  renderCodes();
  const keys = $('#codes').querySelectorAll('.c-key'); keys[keys.length - 1].focus();
});
$('#saveCodes').addEventListener('click', () => {
  readCodes();
  const seen = new Set(), dup = state.codes.find(c => { const k = c.code.toLowerCase(); if (seen.has(k)) return true; seen.add(k); return false; });
  if (dup){ toast(`Kürzel „${dup.code}“ ist doppelt.`); return; }
  save(); renderCodes(); toast('Dienstarten gespeichert');
});

/* ---------- settings view ---------- */
function renderSettings(){
  const s = state.settings;
  $('#setName').value = s.name; $('#setKey').value = s.apiKey; $('#setModel').value = s.model;
  setModeUI(s.mode);
}
function setModeUI(mode){
  $('#modeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#claudeBox').hidden = mode !== 'claude';
  $('#modeHint').textContent = mode === 'claude'
    ? 'Claude liest das Foto wie ein Mensch: findet deine Zeile, ordnet Kürzel den Tagen zu und markiert unsichere Stellen. Braucht Internet und einen API-Schlüssel (kostet pro Scan wenige Cent).'
    : 'Texterkennung direkt im Browser, kostenlos und ohne Schlüssel. Bei Tabellen-Fotos deutlich ungenauer: Ergebnis immer prüfen.';
}
$('#modeSeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => setModeUI(b.dataset.mode)));
$('#showKey').addEventListener('click', () => { const i = $('#setKey'); i.type = i.type === 'password' ? 'text' : 'password'; });
$('#saveSettings').addEventListener('click', () => {
  const s = state.settings;
  s.name = $('#setName').value.trim();
  s.apiKey = $('#setKey').value.trim();
  s.model = $('#setModel').value;
  s.mode = $('#modeSeg .on')?.dataset.mode || 'claude';
  save(); renderModePill(); toast('Einstellungen gespeichert');
});

/* ---------- export / backup ---------- */
function download(name, text, type){
  const blob = new Blob([text], {type});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function icsEscape(s){ return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function buildIcs(keys){
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Liqstorm//Dienstplan//DE', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Dienstplan'];
  let count = 0;
  for (const k of keys){
    const e = state.days[k]; if (!e || !e.code) continue;
    const def = codeDef(e.code);
    if (def && def.kind === 'off' && /^x$|frei/i.test(def.code + ' ' + def.label)) continue; // skip plain days off
    const ymd = k.replace(/-/g, ''), {start, end} = timesOf(e);
    const title = def ? `${def.label} (${e.code})` : `Dienst ${e.code}`;
    lines.push('BEGIN:VEVENT', `UID:${k}@dienstplan.liqstorm`, `DTSTAMP:${stamp}`, `SUMMARY:${icsEscape(title)}`);
    if (isTime(start) && isTime(end) && def?.kind !== 'off'){
      const [y, m, d] = k.split('-').map(Number);
      const overnight = end <= start;
      const endDate = overnight ? new Date(y, m - 1, d + 1) : new Date(y, m - 1, d);
      const endYmd = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(endDate.getDate())}`;
      lines.push(`DTSTART:${ymd}T${start.replace(':', '')}00`, `DTEND:${endYmd}T${end.replace(':', '')}00`);
    } else {
      const [y, m, d] = k.split('-').map(Number), nx = new Date(y, m - 1, d + 1);
      lines.push(`DTSTART;VALUE=DATE:${ymd}`, `DTEND;VALUE=DATE:${nx.getFullYear()}${pad(nx.getMonth() + 1)}${pad(nx.getDate())}`, 'TRANSP:TRANSPARENT');
    }
    if (e.note) lines.push(`DESCRIPTION:${icsEscape(e.note)}`);
    lines.push('END:VEVENT');
    count++;
  }
  lines.push('END:VCALENDAR');
  return {text: lines.join('\r\n') + '\r\n', count};
}
$('#icsMonth').addEventListener('click', () => {
  const prefix = `${viewY}-${pad(viewM + 1)}-`;
  const {text, count} = buildIcs(Object.keys(state.days).filter(k => k.startsWith(prefix)).sort());
  if (!count){ toast('In diesem Monat gibt es noch keine Dienste.'); return; }
  download(`dienstplan-${viewY}-${pad(viewM + 1)}.ics`, text, 'text/calendar');
  toast(`${count} Termine exportiert`);
});
$('#icsAll').addEventListener('click', () => {
  const {text, count} = buildIcs(Object.keys(state.days).sort());
  if (!count){ toast('Noch keine Dienste vorhanden.'); return; }
  download('dienstplan.ics', text, 'text/calendar');
  toast(`${count} Termine exportiert`);
});
$('#backupBtn').addEventListener('click', () => {
  const data = {...state, settings: {...state.settings, apiKey: ''}}; // never put the key into a file
  download(`dienstplan-backup-${keyOf(now.getFullYear(), now.getMonth(), now.getDate())}.json`, JSON.stringify(data, null, 2), 'application/json');
});
$('#restoreBtn').addEventListener('click', () => $('#restoreInput').click());
$('#restoreInput').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d || typeof d.days !== 'object' || !Array.isArray(d.codes)) throw new Error();
    if (!confirm('Backup laden? Dein aktueller Plan wird ersetzt.')) return;
    state.days = d.days; state.codes = d.codes;
    Object.assign(state.settings, {...d.settings, apiKey: state.settings.apiKey});
    save(); renderSettings(); renderModePill(); toast('Backup geladen');
  } catch { toast('Diese Datei ist kein gültiges Dienstplan-Backup.'); }
});
$('#wipeBtn').addEventListener('click', () => {
  if (!confirm('Wirklich alle Dienste, Dienstarten und Einstellungen auf diesem Gerät löschen?')) return;
  localStorage.removeItem(STORE_KEY);
  location.reload();
});

/* ---------- scan view ---------- */
function renderScanForm(){
  const sel = $('#scanMonth');
  if (!sel.options.length){
    sel.innerHTML = MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('');
    // rosters are usually published for the coming month
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    sel.value = String(next.getMonth()); $('#scanYear').value = next.getFullYear();
  }
  if (!$('#scanName').value) $('#scanName').value = state.settings.name;
  renderThumbs();
  if (entryMode === 'manual') openManual();
}
$('#camBtn').addEventListener('click', () => $('#camInput').click());
$('#galBtn').addEventListener('click', () => $('#galInput').click());
$('#camInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
$('#galInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
(() => {
  const d = $('#drop');
  d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('over'); });
  d.addEventListener('dragleave', () => d.classList.remove('over'));
  d.addEventListener('drop', e => { e.preventDefault(); d.classList.remove('over'); addFiles(e.dataTransfer.files); });
})();

// Current Claude models read images up to 2576 px on the long edge; anything larger is downscaled by the API anyway.
const MAX_SIDE = 2576;

async function loadBitmap(file){
  try { return await createImageBitmap(file, {imageOrientation: 'from-image'}); }
  catch {
    return await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
}
function canvasToImage(c, quality = 0.92){
  const dataUrl = c.toDataURL('image/jpeg', quality);
  return {dataUrl, base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', w: c.width, h: c.height};
}
/** Overview image for the API (max 2576 px). The original file is kept so zoomed crops can be cut at full resolution later. */
async function prepareImage(file){
  const bmp = await loadBitmap(file);
  const ow = bmp.width, oh = bmp.height, s = Math.min(1, MAX_SIDE / Math.max(ow, oh));
  const c = document.createElement('canvas'); c.width = Math.round(ow * s); c.height = Math.round(oh * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return {file, ow, oh, ...canvasToImage(c)};
}
async function addFiles(list){
  const files = [...list].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  setStatus('busy', 'Bilder werden vorbereitet');
  for (const f of files){
    try { photos.push({id: Math.random().toString(36).slice(2), name: f.name, ...(await prepareImage(f))}); }
    catch { toast(`„${f.name}“ konnte nicht gelesen werden.`); }
  }
  if (photos.length > 6){ photos = photos.slice(0, 6); toast('Maximal 6 Fotos pro Scan.'); }
  setStatus('', '');
  renderThumbs();
}
function renderThumbs(scanning = false){
  $('#thumbs').innerHTML = photos.map(p =>
    `<div class="thumb${scanning ? ' scanning' : ''}"><img src="${p.dataUrl}" alt="${esc(p.name)}">${scanning ? '' : `<button type="button" data-id="${p.id}" aria-label="Foto entfernen">✕</button>`}</div>`).join('');
  $('#thumbs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { photos = photos.filter(p => p.id !== b.dataset.id); renderThumbs(); }));
  $('#recognizeBtn').disabled = !photos.length || scanning;
}
function setStatus(kind, text){
  const s = $('#scanStatus');
  s.className = 'status' + (kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : '');
  s.innerHTML = kind === 'busy' ? `<span class="spin"></span>${esc(text)}` : esc(text);
}

$('#recognizeBtn').addEventListener('click', async () => {
  const month = +$('#scanMonth').value, year = +$('#scanYear').value, name = $('#scanName').value.trim();
  if (!name){ toast('Bitte deinen Namen eintragen, so wie er auf dem Plan steht.'); $('#scanName').focus(); return; }
  if (!(year >= 2000 && year <= 2100)){ toast('Bitte ein gültiges Jahr eintragen.'); return; }
  if (name !== state.settings.name){ state.settings.name = name; save(); }
  const useClaude = state.settings.mode === 'claude';
  if (useClaude && !state.settings.apiKey){
    toast('Für die KI-Erkennung fehlt der API-Schlüssel (System).'); show('settings'); return;
  }
  renderThumbs(true);
  $('#scanFallback').hidden = true;
  setStatus('busy', useClaude ? 'Claude sucht deine Zeile' : 'Texterkennung läuft');
  try {
    const r = useClaude ? await recognizeWithClaude({year, month, name}) : await recognizeOffline({year, month, name});
    scanResult = {year, month, ...r};
    renderReview();
    const found = Object.values(scanResult.entries).filter(e => e.code).length;
    const unsure = Object.values(scanResult.entries).filter(e => e.code && e.uncertain).length;
    setStatus(found ? 'ok' : 'err', found ? `${found} Tage erkannt${unsure ? `, ${unsure} unsicher` : ''}` : 'Keine Dienste für deinen Namen gefunden. Name und Foto prüfen oder manuell eintragen.');
    $('#scanFallback').hidden = found >= daysIn(year, month) * 0.6 && unsure <= 5;
  } catch (err){
    console.error(err);
    setStatus('err', err.userMessage || 'Erkennung fehlgeschlagen: ' + (err.message || err));
    $('#scanFallback').hidden = false;
  } finally {
    renderThumbs(false);
  }
});

/* --- Claude vision recognition --- */
let sdkPromise = null;
const loadSdk = () => (sdkPromise ??= import(SDK_URL).then(m => m.default || m.Anthropic));

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['person_found', 'matched_name', 'entries', 'unknown_codes', 'notes'],
  properties: {
    person_found: {type: 'boolean'},
    matched_name: {type: 'string', description: 'Name exactly as printed on the roster row that was used, or empty.'},
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day', 'code', 'start', 'end', 'uncertain'],
        properties: {
          day: {type: 'integer', description: 'Day of month, 1-31.'},
          code: {type: 'string', description: 'Shift code exactly as printed in the cell, or empty string if the cell is blank.'},
          start: {type: 'string', description: 'HH:MM if a start time is printed for this day, else empty.'},
          end: {type: 'string', description: 'HH:MM if an end time is printed for this day, else empty.'},
          uncertain: {type: 'boolean', description: 'True if the cell was hard to read or the column/day mapping is doubtful.'},
        },
      },
    },
    unknown_codes: {
      type: 'array',
      description: 'Codes found in the row that are not in the known list, with their meaning if a legend on the roster explains them.',
      items: {
        type: 'object', additionalProperties: false, required: ['code', 'label', 'start', 'end'],
        properties: {code: {type: 'string'}, label: {type: 'string'}, start: {type: 'string'}, end: {type: 'string'}},
      },
    },
    notes: {type: 'string', description: 'Short note in German for the user about problems (blurry area, multiple matching names, cut-off days). Empty if none.'},
  },
};

const READ_PROMPT = `Du liest fotografierte Dienstpläne (Schichtpläne), vor allem aus Krankenhaus und Pflege.

Aufgabe: Gib für jeden Tag des angegebenen Monats das Dienstkürzel der genannten Person zurück.

Du bekommst je Foto eine Übersicht und, falls die Zeile der Person gefunden wurde, vergrößerte Ausschnitte in voller Auflösung. Jeder Ausschnitt zeigt oben die Kopfzeile mit Tagesnummern bzw. Wochentagen und darunter die Zeile der Person zwischen zwei orangen Linien, links die Namensspalte. Lies die Zellen aus den Ausschnitten, die Übersicht dient nur zur Orientierung. Benachbarte Ausschnitte überlappen sich um etwa eine Spalte.

Regeln:
- Ordne jede Zelle über die Tagesnummer in der Kopfzeile dem Tag zu, nicht durch Abzählen. Prüfe die Zuordnung an Wochenenden und Wochentagen gegen den Kalender des Monats.
- Übernimm Kürzel genau so, wie sie in der Zelle stehen (z. B. "F", "S2", "N", "U", "/"). Handschriftliche Korrekturen oder Durchstreichungen haben Vorrang vor dem gedruckten Wert. Stehen zwei Kürzel in einer Zelle, gib das gültige zurück und setze uncertain=true.
- Leere Zellen bekommen code "". Erfinde keine Werte. Wenn du dir bei einer Zelle nicht sicher bist, gib deine beste Lesart an und setze uncertain=true.
- Wenn der Plan eine Legende mit Uhrzeiten oder Bedeutungen der Kürzel hat, nutze sie für unknown_codes. Uhrzeiten, die direkt in einer Zelle stehen, kommen in start/end dieses Tages.
- Fehlen Tage auf allen Fotos, lass sie leer und nenne das in notes.
- Gib für jeden Tag des Monats genau einen Eintrag zurück, auch für leere Tage.`;

const LOCATE_PROMPT = `Du bekommst ein Foto eines Dienstplans (Tabelle: Namen in Zeilen, Tage in Spalten, oder umgekehrt). Finde die Zeile der genannten Person und gib Pixelkoordinaten im gelieferten Bild zurück (Ursprung oben links, x nach rechts, y nach unten). Die Koordinaten werden benutzt, um Ausschnitte in voller Auflösung zu schneiden, also lieber etwas großzügig als zu knapp. Liegen die Tage in Zeilen und die Namen in Spalten, setze transposed=true und lass die Koordinaten 0.`;

const LOCATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['person_found', 'matched_name', 'transposed', 'header_found', 'header_top', 'header_bottom', 'table_left', 'days_left', 'days_right',
    'first_day', 'last_day', 'row_top_left', 'row_bottom_left', 'row_top_right', 'row_bottom_right'],
  properties: {
    person_found: {type: 'boolean'},
    matched_name: {type: 'string', description: 'Name as printed in the row that was found, or empty.'},
    transposed: {type: 'boolean', description: 'True if days run down the rows and people across the columns.'},
    header_found: {type: 'boolean', description: 'True if the header row with day numbers is visible in this photo.'},
    header_top: {type: 'integer', description: 'y of the top edge of the header row(s) with day numbers and weekdays.'},
    header_bottom: {type: 'integer', description: 'y of the bottom edge of that header.'},
    table_left: {type: 'integer', description: 'x of the left edge of the name column.'},
    days_left: {type: 'integer', description: 'x of the left edge of the first visible day column.'},
    days_right: {type: 'integer', description: 'x of the right edge of the last visible day column.'},
    first_day: {type: 'integer', description: 'Day number of the first visible day column.'},
    last_day: {type: 'integer', description: 'Day number of the last visible day column.'},
    row_top_left: {type: 'integer', description: 'y of the top edge of the person\'s row at x = days_left.'},
    row_bottom_left: {type: 'integer', description: 'y of the bottom edge of the person\'s row at x = days_left.'},
    row_top_right: {type: 'integer', description: 'y of the top edge of the person\'s row at x = days_right.'},
    row_bottom_right: {type: 'integer', description: 'y of the bottom edge of the person\'s row at x = days_right.'},
  },
};

function apiErrorMessage(Anthropic, err){
  if (err instanceof Anthropic.AuthenticationError) return 'Der API-Schlüssel wurde abgelehnt. Bitte unter System prüfen.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Der API-Schlüssel hat keinen Zugriff auf dieses Modell.';
  if (err instanceof Anthropic.NotFoundError) return 'Dieses Modell gibt es nicht. Bitte unter System ein anderes wählen.';
  if (err instanceof Anthropic.RateLimitError) return 'Zu viele Anfragen oder Guthaben aufgebraucht. Kurz warten bzw. Guthaben in der Anthropic Console prüfen.';
  if (err instanceof Anthropic.BadRequestError) return 'Die Anfrage wurde abgelehnt: ' + (err.error?.error?.message || err.message);
  if (err instanceof Anthropic.APIConnectionError) return 'Keine Verbindung zur Anthropic-API. Internet prüfen.';
  if (err instanceof Anthropic.APIError) return `API-Fehler (${err.status ?? '?'}). Bitte später erneut versuchen.`;
  return '';
}

/** One structured-output request; returns the parsed JSON object. */
async function askClaude(client, Anthropic, {system, content, schema, effort}){
  const model = state.settings.model || 'claude-opus-5-5';
  const isHaiku = model.startsWith('claude-haiku');
  const params = {
    model,
    max_tokens: 16000,
    system,
    output_config: isHaiku ? {format: {type: 'json_schema', schema}} : {effort, format: {type: 'json_schema', schema}},
    messages: [{role: 'user', content}],
  };
  // Server-side refusal fallback (Opus 5.5 / Sonnet 5.5, not Haiku).
  if (!isHaiku){ params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
  let res;
  try { res = await client.beta.messages.create(params); }
  catch (err){ const e = new Error(err.message); e.userMessage = apiErrorMessage(Anthropic, err); throw e; }
  if (res.stop_reason === 'refusal'){ const e = new Error('refusal'); e.userMessage = 'Die Anfrage wurde vom Modell abgelehnt. Bitte ein anderes Foto versuchen.'; throw e; }
  if (res.stop_reason === 'max_tokens'){ const e = new Error('max_tokens'); e.userMessage = 'Antwort wurde abgeschnitten. Bitte mit weniger Fotos erneut versuchen.'; throw e; }
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(text); }
  catch { const e = new Error('parse'); e.userMessage = 'Die Antwort konnte nicht gelesen werden. Bitte erneut versuchen.'; throw e; }
}

/** Pass 1: where is the person's row on this photo? Returns null if not usable. */
async function locateRow(client, Anthropic, photo, name, year, month){
  const loc = await askClaude(client, Anthropic, {
    system: LOCATE_PROMPT, effort: 'high', schema: LOCATE_SCHEMA,
    content: [
      {type: 'image', source: {type: 'base64', media_type: photo.mediaType, data: photo.base64}},
      {type: 'text', text: `Person: ${name}\nMonat: ${MONTHS[month]} ${year} (${daysIn(year, month)} Tage)\nBildgröße: ${photo.w} × ${photo.h} Pixel`},
    ],
  });
  const {w, h} = photo, n = daysIn(year, month);
  const rowH = ((loc.row_bottom_left - loc.row_top_left) + (loc.row_bottom_right - loc.row_top_right)) / 2;
  const ok = loc.person_found && !loc.transposed
    && loc.days_right - loc.days_left > w * 0.15 && loc.days_left >= 0 && loc.days_right <= w * 1.02
    && rowH >= 3 && rowH < h * 0.2
    && [loc.row_top_left, loc.row_top_right, loc.row_bottom_left, loc.row_bottom_right].every(y => y >= 0 && y <= h)
    && loc.first_day >= 1 && loc.last_day <= n && loc.last_day >= loc.first_day;
  return ok ? {...loc, rowH} : null;
}

/** Cut full-resolution crops around the person's row: header band on top, row band below, name column on the left. */
async function buildTiles(photo, loc){
  const bmp = await loadBitmap(photo.file);
  const s = bmp.width / photo.w;                      // overview px -> original px
  const W = bmp.width, H = bmp.height;
  const clampX = v => Math.max(0, Math.min(W, v)), clampY = v => Math.max(0, Math.min(H, v));
  const dl = loc.days_left * s, dr = loc.days_right * s;
  const visible = loc.last_day - loc.first_day + 1, dayW = (dr - dl) / visible;
  const lerp = (a, b, x) => (a + (b - a) * ((x - dl) / Math.max(1, dr - dl))) * s;
  const top = x => lerp(loc.row_top_left, loc.row_top_right, x), bot = x => lerp(loc.row_bottom_left, loc.row_bottom_right, x);
  const rowH = loc.rowH * s, pad = rowH * 1.1;

  // name column: left part only, names are usually left-aligned
  const tl = Math.min(loc.table_left, loc.days_left) * s;
  const nameW = Math.max(0, Math.min(dl - tl, Math.max(dayW * 4, 600)));
  const hasHeader = loc.header_found && loc.header_bottom > loc.header_top;
  const hPad = hasHeader ? (loc.header_bottom - loc.header_top) * s * 0.25 : 0;
  const hy0 = hasHeader ? clampY(loc.header_top * s - hPad) : 0, hy1 = hasHeader ? clampY(loc.header_bottom * s + hPad) : 0;

  const k = Math.max(1, Math.min(4, Math.ceil((dr - dl) / 1500)));
  const tiles = [];
  for (let i = 0; i < k; i++){
    const a = Math.floor(i * visible / k), b = Math.floor((i + 1) * visible / k) - 1;
    const x0 = clampX(dl + a * dayW - dayW * 0.6), x1 = clampX(dl + (b + 1) * dayW + dayW * 0.6);
    const y0 = clampY(Math.min(top(x0), top(x1), top(tl)) - pad), y1 = clampY(Math.max(bot(x0), bot(x1), bot(tl)) + pad);
    const hh = hy1 - hy0, bh = y1 - y0, gap = hasHeader ? Math.max(6, Math.round(rowH * 0.25)) : 0;
    const cw = Math.round(nameW + 4 + (x1 - x0)), ch = Math.round(hh + gap + bh);
    if (x1 - x0 < 10 || bh < 10) continue;
    const f = Math.min(2, MAX_SIDE / Math.max(cw, ch));  // upscale small crops a little, never above the API limit
    const c = document.createElement('canvas'); c.width = Math.round(cw * f); c.height = Math.round(ch * f);
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    const put = (sx, sy, sw, sh, dx, dy) => { if (sw > 1 && sh > 1) g.drawImage(bmp, sx, sy, sw, sh, dx * f, dy * f, sw * f, sh * f); };
    if (hasHeader){ put(tl, hy0, nameW, hh, 0, 0); put(x0, hy0, x1 - x0, hh, nameW + 4, 0); }
    const by = hh + gap;
    put(tl, y0, nameW, bh, 0, by); put(x0, y0, x1 - x0, bh, nameW + 4, by);
    // separators and row markers
    g.fillStyle = '#9aa4b2';
    if (hasHeader) g.fillRect(0, hh * f, c.width, gap * f);
    g.fillRect(nameW * f, 0, 4 * f, c.height);
    g.strokeStyle = 'rgba(255,120,0,.9)'; g.lineWidth = Math.max(2, 2 * f);
    const line = (yA, yB, off) => { g.beginPath(); g.moveTo(0, (by + yA - y0 + off) * f); g.lineTo(c.width, (by + yB - y0 + off) * f); g.stroke(); };
    line(top(tl), top(x1), -3); line(bot(tl), bot(x1), 3);
    tiles.push({...canvasToImage(c), from: loc.first_day + a, to: loc.first_day + b});
  }
  bmp.close?.();
  return tiles;
}

async function recognizeWithClaude({year, month, name}){
  const Anthropic = await loadSdk().catch(() => {
    const e = new Error('sdk'); e.userMessage = 'Die KI-Bibliothek konnte nicht geladen werden. Besteht eine Internetverbindung?'; throw e;
  });
  const client = new Anthropic({apiKey: state.settings.apiKey, dangerouslyAllowBrowser: true});
  const n = daysIn(year, month);
  const firstDow = DOW_LONG[dowIdx(year, month, 1)];
  const known = state.codes.map(c => `${c.code} = ${c.label}${c.start ? ` (${c.start}–${c.end})` : ''}`).join('\n');
  const weekends = [];
  for (let d = 1; d <= n; d++) if (dowIdx(year, month, d) > 4) weekends.push(`${d}. (${DOW[dowIdx(year, month, d)]})`);

  // Pass 1: find the row on every photo (in parallel). A failed lookup only means that photo gets no zoomed crops.
  const located = await Promise.all(photos.map(p => locateRow(client, Anthropic, p, name, year, month).catch(err => {
    if (!['refusal', 'max_tokens', 'parse'].includes(err.message)) throw err; // key / network problems stop the scan
    return null;
  })));
  setStatus('busy', 'Claude liest die Ausschnitte');

  const content = [];
  let tileCount = 0;
  for (let i = 0; i < photos.length; i++){
    const p = photos[i];
    content.push({type: 'text', text: `Foto ${i + 1}, Übersicht:`});
    content.push({type: 'image', source: {type: 'base64', media_type: p.mediaType, data: p.base64}});
    if (!located[i]) continue;
    let tiles = [];
    try { tiles = await buildTiles(p, located[i]); } catch (err){ console.error(err); }
    tiles.forEach((t, j) => {
      content.push({type: 'text', text: `Foto ${i + 1}, Ausschnitt ${j + 1} von ${tiles.length}: Tagesspalten etwa ${t.from} bis ${t.to}, Zeile „${located[i].matched_name}“ zwischen den orangen Linien.`});
      content.push({type: 'image', source: {type: 'base64', media_type: t.mediaType, data: t.base64}});
    });
    tileCount += tiles.length;
  }
  content.push({type: 'text', text:
`Person: ${name}
Monat: ${MONTHS[month]} ${year} (${n} Tage, der 1. ist ein ${firstDow})
Wochenenden: ${weekends.join(', ')}
Anzahl Fotos: ${photos.length}

Bekannte Kürzel dieser Person:
${known}

Lies die Dienste dieser Person für jeden Tag 1 bis ${n} aus.`});

  const data = await askClaude(client, Anthropic, {system: READ_PROMPT, effort: 'high', schema: RESULT_SCHEMA, content});

  // Learn codes from the roster legend that the user hasn't defined yet.
  for (const u of data.unknown_codes || []){
    const code = String(u.code || '').trim();
    if (!code || codeDef(code)) continue;
    const hasTimes = isTime(u.start) && isTime(u.end);
    state.codes.push({code, label: u.label?.trim() || code, start: hasTimes ? u.start : '', end: hasTimes ? u.end : '', color: '#94a3b8', kind: hasTimes ? 'work' : 'off'});
  }
  save();

  const entries = {};
  for (const e of data.entries || []){
    const d = Number(e.day);
    if (!(d >= 1 && d <= n)) continue;
    entries[d] = {code: String(e.code || '').trim(), start: isTime(e.start) ? e.start : '', end: isTime(e.end) ? e.end : '', uncertain: !!e.uncertain};
  }
  const notes = [
    data.person_found ? '' : 'Name wurde auf dem Foto nicht sicher gefunden.',
    data.matched_name ? `Gelesene Zeile: „${data.matched_name}“.` : '',
    tileCount ? '' : 'Deine Zeile konnte nicht vergrößert werden, gelesen wurde nur die Übersicht. Ein näheres, geraderes Foto hilft.',
    data.notes || '',
  ].filter(Boolean).join(' ');
  return {entries, notes};
}

/* --- offline OCR fallback (tesseract.js) --- */
let tessPromise = null;
function loadTesseract(){
  return tessPromise ??= new Promise((res, rej) => {
    if (window.Tesseract) return res(window.Tesseract);
    const s = document.createElement('script'); s.src = TESSERACT_URL;
    s.onload = () => res(window.Tesseract);
    s.onerror = () => { tessPromise = null; rej(Object.assign(new Error('tess'), {userMessage: 'Texterkennung konnte nicht geladen werden (einmalig Internet nötig).'})); };
    document.head.appendChild(s);
  });
}
async function recognizeOffline({year, month, name}){
  const T = await loadTesseract();
  const worker = await T.createWorker('deu', 1, {logger: m => {
    if (m.status === 'recognizing text') setStatus('busy', `Texterkennung ${Math.round(m.progress * 100)} %`);
  }});
  const n = daysIn(year, month);
  const known = new Map(state.codes.map(c => [c.code.toLowerCase(), c.code]));
  const needle = name.toLowerCase().split(/[\s,.]+/).filter(w => w.length > 1).sort((a, b) => b.length - a.length)[0] || name.toLowerCase();
  let best = null;
  try {
    for (const p of photos){
      const {data} = await worker.recognize(p.dataUrl);
      for (const line of data.text.split('\n')){
        const low = line.toLowerCase(), at = low.indexOf(needle);
        if (at < 0) continue;
        const rest = line.slice(at + needle.length).replace(/^[^\s]*/, '');
        const tokens = rest.split(/[\s|]+/).filter(Boolean);
        const hits = tokens.filter(t => known.has(t.toLowerCase()) || /^[-/]$/.test(t)).length;
        if (!best || hits > best.hits) best = {tokens, hits, line};
      }
    }
  } finally { await worker.terminate(); }
  const entries = {};
  for (let d = 1; d <= n; d++) entries[d] = {code: '', start: '', end: '', uncertain: true};
  if (!best) return {entries, notes: 'Dein Name wurde im erkannten Text nicht gefunden. Tipp: KI-Erkennung nutzen oder die Tage unten von Hand setzen.'};
  // Assume the row lists one cell per day in order; map known codes, treat "-" or "/" as a day off.
  const off = state.codes.find(c => c.kind === 'off')?.code || '';
  best.tokens.slice(0, n).forEach((t, i) => {
    const c = known.get(t.toLowerCase());
    entries[i + 1] = {code: c || (/^[-/]$/.test(t) ? off : ''), start: '', end: '', uncertain: true};
  });
  return {entries, notes: `Offline erkannt (ungenau). Gelesene Zeile: „${best.line.trim().slice(0, 140)}“. Bitte jeden Tag prüfen.`};
}

/* --- review & apply --- */
function renderReview(){
  const {year, month, entries, notes} = scanResult, n = daysIn(year, month);
  $('#reviewPanel').hidden = false;
  $('#reviewTitle').textContent = `${MONTHS[month]} ${year}`;
  $('#reviewCount').textContent = `${Object.values(entries).filter(e => e.code).length} / ${n} Tage`;
  $('#reviewNotes').hidden = !notes; $('#reviewNotes').textContent = notes || '';
  const opts = cur => {
    const list = state.codes.map(c => c.code);
    if (cur && !list.some(c => c.toLowerCase() === cur.toLowerCase())) list.push(cur);
    return `<option value="">–</option>` + list.map(c => `<option value="${esc(c)}"${c.toLowerCase() === (cur || '').toLowerCase() ? ' selected' : ''}>${esc(c)}${codeDef(c) ? ' · ' + esc(codeDef(c).label) : ' · neu'}</option>`).join('');
  };
  let html = '';
  for (let d = 1; d <= n; d++){
    const e = entries[d] || {code: '', start: '', end: '', uncertain: false}, wi = dowIdx(year, month, d);
    const def = codeDef(e.code);
    html += `<div class="rv${e.uncertain && e.code ? ' unsure' : ''}${wi > 4 ? ' we' : ''}" data-d="${d}">
      <span class="dd">${pad(d)}.${pad(month + 1)}.<small>${DOW[wi].toUpperCase()}</small></span>
      <select aria-label="Dienst am ${d}.">${opts(e.code)}</select>
      <input type="time" class="s" value="${e.start || def?.start || ''}" aria-label="Beginn">
      <input type="time" class="e" value="${e.end || def?.end || ''}" aria-label="Ende">
    </div>`;
  }
  $('#review').innerHTML = html;
  $('#review').querySelectorAll('.rv').forEach(row => row.querySelector('select').addEventListener('change', ev => {
    const def = codeDef(ev.target.value);
    row.querySelector('.s').value = def?.start || ''; row.querySelector('.e').value = def?.end || '';
    row.classList.remove('unsure');
  }));
  $('#reviewPanel').scrollIntoView({behavior: 'smooth', block: 'start'});
}
$('#discardBtn').addEventListener('click', () => { scanResult = null; $('#reviewPanel').hidden = true; setStatus('', ''); });
$('#applyBtn').addEventListener('click', () => {
  if (!scanResult) return;
  const {year, month} = scanResult, keep = $('#keepManual').checked;
  let applied = 0, skipped = 0;
  $('#review').querySelectorAll('.rv').forEach(row => {
    const d = +row.dataset.d, code = row.querySelector('select').value, k = keyOf(year, month, d), cur = state.days[k];
    if (!code) return;
    if (keep && cur?.src === 'manual'){ skipped++; return; }
    if (!codeDef(code)) state.codes.push({code, label: code, start: '', end: '', color: '#94a3b8', kind: 'work'});
    const def = codeDef(code), s = row.querySelector('.s').value, e = row.querySelector('.e').value;
    const entry = {code, src: 'scan'};
    if (s && s !== (def.start || '')) entry.start = s;
    if (e && e !== (def.end || '')) entry.end = e;
    if (cur?.note) entry.note = cur.note;
    state.days[k] = entry; applied++;
  });
  save();
  scanResult = null; photos = []; $('#reviewPanel').hidden = true; setStatus('', ''); renderThumbs();
  viewY = year; viewM = month; show('plan');
  toast(`${applied} Tage übernommen${skipped ? `, ${skipped} manuelle behalten` : ''}`, 3400);
});

/* ---------- manual entry ---------- */
let entryMode = 'photo', brush = null;
const drafts = {};   // 'YYYY-MM' -> {year, month, days:{d: code}}

function setEntryMode(mode){
  entryMode = mode;
  $('#entrySeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.entry === mode));
  $('#photoPanel').hidden = mode !== 'photo';
  $('#manualPanel').hidden = mode !== 'manual';
  $('#reviewPanel').hidden = mode !== 'photo' || !scanResult;
  if (mode === 'manual') openManual();
}
$('#entrySeg').querySelectorAll('button').forEach(b => b.addEventListener('click', () => setEntryMode(b.dataset.entry)));
$('#toManualBtn').addEventListener('click', () => { setEntryMode('manual'); $('#manualPanel').scrollIntoView({behavior: 'smooth', block: 'start'}); });
$('#manualFromPlan').addEventListener('click', () => {
  show('scan');
  $('#scanMonth').value = String(viewM); $('#scanYear').value = viewY;
  setEntryMode('manual');
});
['#scanMonth', '#scanYear'].forEach(s => $(s).addEventListener('change', () => { if (entryMode === 'manual') openManual(); }));

function currentDraft(){
  const year = +$('#scanYear').value, month = +$('#scanMonth').value;
  if (!(year >= 2000 && year <= 2100)) return null;
  const ym = `${year}-${pad(month + 1)}`;
  if (!drafts[ym]){
    const days = {}, n = daysIn(year, month);
    for (let d = 1; d <= n; d++){ const e = state.days[keyOf(year, month, d)]; if (e?.code) days[d] = e.code; }
    // a scan of the same month that was not applied yet fills the still empty days
    if (scanResult && scanResult.year === year && scanResult.month === month)
      for (const [d, e] of Object.entries(scanResult.entries)) if (e.code && !days[d]) days[d] = e.code;
    drafts[ym] = {year, month, days};
  }
  return drafts[ym];
}
function openManual(){
  if (!brush || !codeDef(brush)) brush = state.codes.find(c => c.kind === 'work')?.code || state.codes[0]?.code || '';
  renderManual();
}
function renderManual(){
  const dr = currentDraft();
  if (!dr){ $('#manualCal').innerHTML = '<p class="hint">Bitte ein gültiges Jahr eintragen.</p>'; return; }
  const {year, month, days} = dr, n = daysIn(year, month), first = dowIdx(year, month, 1);
  $('#manualTitle').textContent = `${MONTHS[month]} ${year}`;
  $('#manualCount').textContent = `${Object.keys(days).length} / ${n} Tage`;
  $('#brush').innerHTML = state.codes.map(c =>
    `<button type="button" data-c="${esc(c.code)}" class="${c.code === brush ? 'on' : ''}" style="--c:${c.color}">${esc(c.code)}<small>${esc(c.label)}</small></button>`).join('')
    + `<button type="button" data-c="" class="erase${brush === '' ? ' on' : ''}">✕<small>Löschen</small></button>`;
  let html = DOW.map((d, i) => `<div class="dow${i > 4 ? ' we' : ''}">${d}</div>`).join('');
  for (let i = 0; i < first; i++) html += '<div class="day pad"></div>';
  for (let d = 1; d <= n; d++){
    const code = days[d], wi = dowIdx(year, month, d), def = codeDef(code);
    html += `<button type="button" class="day${wi > 4 ? ' we' : ''}${code ? ' set' : ''}" data-d="${d}"${code ? ` style="--c:${colorOf(code)}"` : ''} aria-label="${d}. ${MONTHS[month]}${code ? ', ' + esc(def?.label || code) : ''}">
      <span class="n">${d}</span>${code ? `<span class="code" style="--c:${colorOf(code)}">${esc(code)}</span>` : ''}</button>`;
  }
  $('#manualCal').innerHTML = html;
}
$('#brush').addEventListener('click', e => {
  const b = e.target.closest('button[data-c]'); if (!b) return;
  brush = b.dataset.c; renderManual();
});
$('#manualCal').addEventListener('click', e => {
  const b = e.target.closest('.day[data-d]'), dr = currentDraft(); if (!b || !dr) return;
  const d = +b.dataset.d;
  if (!brush || dr.days[d] === brush) delete dr.days[d]; else dr.days[d] = brush;
  renderManual();
});
$('#fillFreeBtn').addEventListener('click', () => {
  const dr = currentDraft(); if (!dr) return;
  const free = state.codes.find(c => c.kind === 'off' && /^x$|frei/i.test(c.code + ' ' + c.label)) || state.codes.find(c => c.kind === 'off');
  if (!free){ toast('Lege zuerst unter Schichten eine Dienstart „Frei“ an.'); return; }
  let added = 0;
  for (let d = 1; d <= daysIn(dr.year, dr.month); d++) if (!dr.days[d]){ dr.days[d] = free.code; added++; }
  renderManual(); toast(added ? `${added} Tage auf ${free.code} gesetzt` : 'Alle Tage sind schon belegt.');
});
$('#manualClearBtn').addEventListener('click', () => {
  const dr = currentDraft(); if (!dr) return;
  dr.days = {}; renderManual(); toast('Monat geleert. Erst „Übernehmen“ ändert deinen Plan.');
});
$('#manualSaveBtn').addEventListener('click', () => {
  const dr = currentDraft(); if (!dr) return;
  const {year, month, days} = dr;
  let changed = 0;
  for (let d = 1; d <= daysIn(year, month); d++){
    const k = keyOf(year, month, d), cur = state.days[k], code = days[d] || '';
    if ((cur?.code || '') === code) continue;           // unchanged: keep times and note
    if (!code){ if (cur?.note) state.days[k] = {code: '', note: cur.note, src: 'manual'}; else delete state.days[k]; }
    else state.days[k] = {code, src: 'manual', ...(cur?.note ? {note: cur.note} : {})};
    changed++;
  }
  save();
  delete drafts[`${year}-${pad(month + 1)}`];
  if (scanResult && scanResult.year === year && scanResult.month === month){ scanResult = null; $('#reviewPanel').hidden = true; }
  viewY = year; viewM = month; show('plan');
  toast(changed ? `${changed} Tage gespeichert` : 'Keine Änderungen', 3000);
});

/* ---------- background embers (bull / bear) ---------- */
(() => {
  const c = $('#sparks'); if (!c || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const x = c.getContext('2d'); let w, h, dpr, parts = [];
  function size(){ dpr = Math.min(devicePixelRatio || 1, 2); w = c.width = innerWidth * dpr; h = c.height = innerHeight * dpr; c.style.width = innerWidth + 'px'; c.style.height = innerHeight + 'px'; }
  function spawn(init){ const side = Math.random() < .5; return {
    x: (side ? Math.random() * .5 : .5 + Math.random() * .5) * w, y: init ? Math.random() * h : h + 10,
    r: (Math.random() * 1.4 + .3) * dpr, v: (Math.random() * .3 + .1) * dpr, a: Math.random() * .5 + .15,
    col: side ? '56,189,248' : '244,63,94', drift: (Math.random() - .5) * .22 * dpr}; }
  function init(){ parts = []; const n = Math.round(Math.min(50, innerWidth / 20)); for (let i = 0; i < n; i++) parts.push(spawn(true)); }
  function tick(){
    x.clearRect(0, 0, w, h);
    for (const p of parts){
      p.y -= p.v; p.x += p.drift; if (p.y < -10) Object.assign(p, spawn(false));
      x.beginPath(); x.arc(p.x, p.y, p.r, 0, Math.PI * 2); x.fillStyle = `rgba(${p.col},${p.a})`; x.shadowBlur = 8 * dpr; x.shadowColor = `rgba(${p.col},.8)`; x.fill();
    }
    requestAnimationFrame(tick);
  }
  size(); init(); tick(); addEventListener('resize', () => { size(); init(); });
})();

/* ---------- boot ---------- */
renderModePill();
renderPlan();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
