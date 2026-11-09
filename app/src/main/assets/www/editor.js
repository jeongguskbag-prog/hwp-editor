// HWP 편집기 — 화면(웹) 부분.
// 엔진: @rhwp/core (MIT, engine/ 폴더, 빌드 때 받음). 이 파일은 엔진 위에 휴대폰용 편집 화면을 만든다.
//
// 구조
// - 페이지마다 <div class="page"> 에 엔진이 그린 SVG 를 넣음. 화면에 가까운 페이지만 그림(IntersectionObserver).
//   SVG 는 viewBox 로 그려져 있어 확대·축소는 div 크기만 바꾸면 됨(다시 그릴 필요 없음).
// - 커서 위치(pos)는 엔진 좌표: 본문 {k:'b', s, p, o} / 표 칸 {k:'c', s, pp, path:[{controlIndex,cellIndex,cellParaIndex}…], o}
//   표 칸은 중첩 표까지 같은 경로(path) 방식 API(…ByPath)로 처리.
// - 키보드 입력은 보이지 않는 textarea(#ime) 로 받음. 맨 앞에 보이지 않는 글자(SENT)를 두어
//   안드로이드 키보드가 keydown 을 주지 않아도 "지움(백스페이스)" 을 알아챔. 한글 조합 중에는 조합 글자를
//   문서에 바로 넣고 바꿔 가며 보여 줌(compositionupdate).
// - 되돌리기는 엔진 스냅샷(saveSnapshot/restoreSnapshot).
import init, { HwpDocument } from './engine/rhwp.js';

const $ = (id) => document.getElementById(id);
const host = window.HwpHost || null; // 안드로이드 앱이 넣어 주는 다리(MainActivity.kt). 브라우저에서는 없음
const SENT = '​';
const scroller = $('scroller');
const pagesBox = $('pages');
const ime = $('ime');

// 엔진이 글자 폭을 잴 때 부르는 함수 (필수)
let measureCtx = null;
let measureFont = '';
globalThis.measureTextWidth = (font, text) => {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (font !== measureFont) { measureCtx.font = font; measureFont = font; }
  return measureCtx.measureText(text).width;
};

const S = {
  doc: null, name: '', fmt: 'hwp',
  pages: [],            // [{el, w, h, dirty}]
  scale: 1, fit: true,
  pos: null,
  dirty: false,
  undo: [], redo: [], lastKind: '', lastTime: 0,
  composing: false, comp: null, ignoreInputUntil: 0,
  visible: new Set(),
};

// ---------- 공통 ----------
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function busy(on, text) {
  $('busy').hidden = !on;
  if (text) $('busyText').textContent = text;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
/** 엔진 호출 결과(JSON 문자열)를 풀고, ok:false 면 오류로 던짐 */
function E(result) {
  const j = typeof result === 'string' ? JSON.parse(result) : result;
  if (j && j.ok === false) throw new Error(j.error || j.message || '편집할 수 없는 위치예요');
  return j;
}
function setDirty(on) {
  S.dirty = on;
  $('dirty').hidden = !on;
}
function extOf(name) { const m = /\.([^.]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }

// ---------- 페이지 그리기 ----------
const observer = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const i = +en.target.dataset.i;
    if (en.isIntersecting) { S.visible.add(i); if (S.pages[i] && S.pages[i].dirty) renderPage(i); }
    else S.visible.delete(i);
  }
}, { root: scroller, rootMargin: '800px 0px' });

function pageSize(i) {
  try { const info = JSON.parse(S.doc.getPageInfo(i)); return { w: info.width, h: info.height }; }
  catch { return { w: 794, h: 1123 }; }
}

function computeFitScale() {
  const maxW = Math.max(...S.pages.map((p) => p.w), 1);
  return Math.max(0.2, (scroller.clientWidth - 16) / maxW);
}

function applySizes() {
  for (const p of S.pages) {
    p.el.style.width = `${p.w * S.scale}px`;
    p.el.style.height = `${p.h * S.scale}px`;
  }
}

/** 쪽 수가 바뀌었을 수 있으니 페이지 상자를 맞추고, 모든 쪽을 "다시 그려야 함" 으로 표시 */
function syncPages() {
  const n = S.doc ? S.doc.pageCount() : 0;
  while (S.pages.length > n) {
    const p = S.pages.pop();
    observer.unobserve(p.el);
    p.el.remove();
    S.visible.delete(S.pages.length);
  }
  for (let i = 0; i < n; i++) {
    let p = S.pages[i];
    if (!p) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.i = String(i);
      pagesBox.appendChild(el);
      p = S.pages[i] = { el, w: 0, h: 0, dirty: true };
      observer.observe(el);
    }
    const sz = pageSize(i);
    p.w = sz.w; p.h = sz.h; p.dirty = true;
  }
  if (S.fit) S.scale = computeFitScale();
  applySizes();
}

function renderPage(i) {
  const p = S.pages[i];
  if (!p || !S.doc) return;
  try {
    p.el.innerHTML = S.doc.renderPageSvg(i);
    const svg = p.el.querySelector('svg');
    if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); }
  } catch (e) {
    p.el.innerHTML = `<div style="padding:20px;color:#b91c1c">이 쪽을 그리지 못했어요: ${String(e.message || e)}</div>`;
  }
  const no = document.createElement('div');
  no.className = 'pno';
  no.textContent = `${i + 1} / ${S.pages.length}`;
  p.el.appendChild(no);
  p.dirty = false;
  if (caretPage === i) p.el.appendChild(caretEl);
}

function renderVisible() {
  for (const i of S.visible) if (S.pages[i] && S.pages[i].dirty) renderPage(i);
}

// ---------- 커서 ----------
const caretEl = document.createElement('div');
caretEl.id = 'caret';
let caretPage = -1;
let caretRect = null;

function cursorRect(pos) {
  if (pos.k === 'b') return JSON.parse(S.doc.getCursorRect(pos.s, pos.p, pos.o));
  return JSON.parse(S.doc.getCursorRectByPath(pos.s, pos.pp, JSON.stringify(pos.path), pos.o));
}

function placeCaret(scrollIntoView = true) {
  if (!S.doc || !S.pos) { caretEl.remove(); caretPage = -1; return; }
  let r;
  try { r = cursorRect(S.pos); } catch { caretEl.remove(); caretPage = -1; return; }
  const p = S.pages[r.pageIndex];
  if (!p) return;
  if (p.dirty) renderPage(r.pageIndex);
  caretRect = r;
  caretPage = r.pageIndex;
  caretEl.style.left = `${r.x * S.scale - 1}px`;
  caretEl.style.top = `${r.y * S.scale}px`;
  caretEl.style.height = `${Math.max(r.height * S.scale, 14)}px`;
  if (caretEl.parentNode !== p.el) p.el.appendChild(caretEl);
  if (scrollIntoView) {
    const cr = caretEl.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    if (cr.top < sr.top + 20) scroller.scrollTop -= (sr.top + 20 - cr.top);
    else if (cr.bottom > sr.bottom - 80) scroller.scrollTop += (cr.bottom - (sr.bottom - 80));
  }
  moveIme();
}

/** 입력칸을 커서 위치(화면 좌표)로 옮김 → 한글 조합창·키보드 제안이 커서 옆에 뜸 */
function moveIme() {
  const cr = caretEl.isConnected ? caretEl.getBoundingClientRect() : null;
  ime.style.position = 'fixed';
  ime.style.left = `${cr ? cr.left : 0}px`;
  ime.style.top = `${cr ? cr.top : 0}px`;
  ime.style.height = `${cr ? Math.max(cr.height, 20) : 20}px`;
}
scroller.addEventListener('scroll', () => { if (S.pos) moveIme(); }, { passive: true });

function posFromHit(h) {
  if (h.cellPath && h.cellPath.length) {
    // 표 칸이면 [{controlIndex, cellIndex, cellParaIndex}] 형식. 글상자·그림 속 글자는 [[n,n,n]] 형식(innerControlIdx)이라
    // 다른 엔진 함수가 필요함 → 아직 지원하지 않는다고 알림 (잘못된 값으로 엉뚱한 곳에 글자가 들어가지 않게)
    const isCell = Number.isInteger(h.parentParaIndex) && h.cellPath.every((c) => c && !Array.isArray(c)
      && Number.isInteger(c.controlIndex) && Number.isInteger(c.cellIndex) && Number.isInteger(c.cellParaIndex));
    if (!isCell) return { unsupported: true };
    return { k: 'c', s: h.sectionIndex, pp: h.parentParaIndex, path: h.cellPath.map((c) => ({ controlIndex: c.controlIndex, cellIndex: c.cellIndex, cellParaIndex: c.cellParaIndex })), o: h.charOffset };
  }
  return { k: 'b', s: h.sectionIndex, p: h.paragraphIndex, o: h.charOffset };
}

function hitAt(pageIndex, x, y) {
  // 엔진은 그린 적 있는(배치가 끝난) 쪽에서만 위치를 찾을 수 있어서, 편집 뒤 아직 안 그린 쪽이면 먼저 그림
  if (S.pages[pageIndex] && S.pages[pageIndex].dirty) renderPage(pageIndex);
  const h = JSON.parse(S.doc.hitTest(pageIndex, x, y));
  if (h == null || h.sectionIndex == null) return null;
  return posFromHit(h);
}

pagesBox.addEventListener('click', (e) => {
  const el = e.target.closest('.page');
  if (!el || !S.doc) return;
  const i = +el.dataset.i;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / S.scale;
  const y = (e.clientY - r.top) / S.scale;
  let pos = null;
  try { pos = hitAt(i, x, y); } catch (err) { /* 빈 곳 */ }
  if (!pos) return;
  if (pos.unsupported) { toast('글상자·그림 안의 글자는 아직 편집할 수 없어요'); return; }
  if (S.composing) ime.blur(); // 조합 중이면 먼저 끝냄
  S.pos = pos;
  S.lastKind = '';
  placeCaret(false);
  focusIme();
});

function focusIme() {
  resetIme();
  ime.focus({ preventScroll: true });
}

// ---------- 편집 기본 동작 (본문/표 칸 공통) ----------
const pathJson = (pos) => JSON.stringify(pos.path);
const cellPara = (pos) => pos.path[pos.path.length - 1].cellParaIndex;
function setCellPara(pos, idx) { pos.path[pos.path.length - 1].cellParaIndex = idx; }

function paraLength(pos) {
  return pos.k === 'b' ? S.doc.getParagraphLength(pos.s, pos.p) : S.doc.getCellParagraphLengthByPath(pos.s, pos.pp, pathJson(pos));
}

/** pos 위치에 글자를 넣고 pos 를 넣은 글자 뒤로 옮김 */
function insertAt(pos, text) {
  const r = pos.k === 'b'
    ? E(S.doc.insertText(pos.s, pos.p, pos.o, text))
    : E(S.doc.insertTextInCellByPath(pos.s, pos.pp, pathJson(pos), pos.o, text));
  pos.o = r.charOffset != null ? r.charOffset : pos.o + text.length;
}
function deleteAt(pos, offset, count) {
  if (count <= 0) return;
  if (pos.k === 'b') E(S.doc.deleteText(pos.s, pos.p, offset, count));
  else E(S.doc.deleteTextInCellByPath(pos.s, pos.pp, pathJson(pos), offset, count));
}
function splitAt(pos) {
  if (pos.k === 'b') {
    const r = E(S.doc.splitParagraph(pos.s, pos.p, pos.o));
    pos.p = r.paraIdx; pos.o = r.charOffset;
  } else {
    const r = E(S.doc.splitParagraphInCellByPath(pos.s, pos.pp, pathJson(pos), pos.o));
    setCellPara(pos, r.cellParaIndex); pos.o = r.charOffset;
  }
}
/** 커서 앞 한 글자를 지움. 문단 맨 앞이면 앞 문단과 합침 */
function backspaceAt(pos) {
  if (pos.o > 0) { deleteAt(pos, pos.o - 1, 1); pos.o -= 1; return true; }
  if (pos.k === 'b') {
    if (pos.p === 0) return false;
    const r = E(S.doc.mergeParagraph(pos.s, pos.p));
    pos.p = r.paraIdx; pos.o = r.charOffset;
    return true;
  }
  if (cellPara(pos) === 0) return false;
  const r = E(S.doc.mergeParagraphInCellByPath(pos.s, pos.pp, pathJson(pos)));
  setCellPara(pos, r.cellParaIndex); pos.o = r.charOffset;
  return true;
}

// ---------- 되돌리기 ----------
const UNDO_LIMIT = 50;
function checkpoint(kind) {
  const now = Date.now();
  // 이어서 치는 글자는 1.5초 안이면 한 번에 되돌림
  if (kind === 'type' && S.lastKind === 'type' && now - S.lastTime < 1500) { S.lastTime = now; return; }
  try {
    S.undo.push({ id: S.doc.saveSnapshot(), pos: S.pos ? clone(S.pos) : null });
    if (S.undo.length > UNDO_LIMIT) S.undo.shift();
  } catch { /* 스냅샷 실패해도 편집은 계속 */ }
  S.redo = [];
  S.lastKind = kind; S.lastTime = now;
  updateUndoButtons();
}
function updateUndoButtons() {
  $('btnUndo').disabled = !S.undo.length;
  $('btnRedo').disabled = !S.redo.length;
}
function restoreFrom(fromStack, toStack, failMsg) {
  if (!fromStack.length || !S.doc) return;
  const target = fromStack.pop();
  try {
    const current = { id: S.doc.saveSnapshot(), pos: S.pos ? clone(S.pos) : null };
    E(S.doc.restoreSnapshot(target.id));
    toStack.push(current);
    S.pos = target.pos;
  } catch {
    toast(failMsg);
  }
  S.lastKind = '';
  updateUndoButtons();
  afterEdit();
}
const undo = () => restoreFrom(S.undo, S.redo, '더 이상 되돌릴 수 없어요');
const redo = () => restoreFrom(S.redo, S.undo, '다시 할 수 없어요');

// ---------- 편집 후 화면 갱신 ----------
function afterEdit(scroll = true) {
  setDirty(true);
  syncPages();
  renderVisible();
  placeCaret(scroll);
}

function edit(kind, fn) {
  if (!S.doc || !S.pos) return;
  checkpoint(kind);
  try { fn(S.pos); } catch (e) { toast(String(e.message || e)); }
  afterEdit();
}

function typeText(text) {
  edit('type', (pos) => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (i > 0) splitAt(pos);
      if (line) insertAt(pos, line);
    });
  });
}

// ---------- 키보드 입력 (보이지 않는 입력칸) ----------
function resetIme() {
  if (S.composing) return;
  ime.value = SENT;
  ime.setSelectionRange(1, 1);
}

/** 조합 중인 글자를 문서에 넣거나 바꿈 */
function replaceComposition(text) {
  const c = S.comp;
  if (!c || !S.doc) return;
  const p = clone(c.base);
  try {
    if (c.len > 0) deleteAt(p, p.o, c.len);
    if (text) insertAt(p, text);
    c.len = text.length;
    S.pos = p;
  } catch (e) { toast(String(e.message || e)); }
  afterEdit();
}

ime.addEventListener('compositionstart', () => {
  if (!S.doc || !S.pos) return;
  checkpoint('type');
  S.composing = true;
  S.comp = { base: clone(S.pos), len: 0 };
});
ime.addEventListener('compositionupdate', (e) => {
  if (S.composing) replaceComposition(e.data || '');
});
ime.addEventListener('compositionend', (e) => {
  if (!S.composing) return;
  replaceComposition(e.data || '');
  S.composing = false;
  S.comp = null;
  S.ignoreInputUntil = performance.now() + 80; // 조합이 끝난 직후 오는 input 은 이미 넣은 글자
  setTimeout(resetIme, 0);
});

ime.addEventListener('beforeinput', (e) => {
  if (S.composing) return;
  if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
    e.preventDefault();
    edit('enter', splitAt);
  }
});

ime.addEventListener('input', (e) => {
  if (S.composing || e.isComposing) return;
  if (performance.now() < S.ignoreInputUntil) { resetIme(); return; }
  const v = ime.value;
  if (!v.startsWith(SENT)) {
    // 맨 앞의 보이지 않는 글자가 지워짐 = 백스페이스
    edit('delete', backspaceAt);
  } else {
    const t = v.slice(SENT.length);
    if (t) typeText(t);
  }
  resetIme();
});

ime.addEventListener('keydown', (e) => {
  if (S.composing || e.isComposing || e.keyCode === 229) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); openSaveMenu(); return; }
  switch (e.key) {
    case 'Enter': e.preventDefault(); edit('enter', splitAt); break;
    case 'Backspace': e.preventDefault(); edit('delete', backspaceAt); break;
    case 'Delete': e.preventDefault(); edit('delete', (pos) => { if (pos.o < paraLength(pos)) deleteAt(pos, pos.o, 1); }); break;
    case 'ArrowLeft': e.preventDefault(); moveH(-1); break;
    case 'ArrowRight': e.preventDefault(); moveH(1); break;
    case 'ArrowUp': e.preventDefault(); moveV(-1); break;
    case 'ArrowDown': e.preventDefault(); moveV(1); break;
    case 'Home': e.preventDefault(); if (S.pos) { S.pos.o = 0; placeCaret(); } break;
    case 'End': e.preventDefault(); if (S.pos) { S.pos.o = paraLength(S.pos); placeCaret(); } break;
    default:
  }
});

function moveH(dir) {
  const pos = S.pos;
  if (!pos) return;
  const len = paraLength(pos);
  if (dir < 0 && pos.o > 0) pos.o -= 1;
  else if (dir > 0 && pos.o < len) pos.o += 1;
  else if (pos.k === 'b') {
    if (dir < 0 && pos.p > 0) { pos.p -= 1; pos.o = paraLength(pos); }
    else if (dir > 0 && pos.p < S.doc.getParagraphCount(pos.s) - 1) { pos.p += 1; pos.o = 0; }
  }
  S.lastKind = '';
  placeCaret();
}
function moveV(dir) {
  if (!caretRect) return;
  const y = dir < 0 ? caretRect.y - 2 : caretRect.y + caretRect.height + 2;
  let pos = null;
  try { pos = hitAt(caretRect.pageIndex, caretRect.x, y); } catch { /* 끝 */ }
  if (pos && !pos.unsupported) { S.pos = pos; S.lastKind = ''; placeCaret(); }
}

// ---------- 문서 열기 · 새 문서 · 저장 ----------
// 저장 안 한 내용 확인. 안드로이드 WebView 는 브라우저 확인 창(confirm)을 띄우지 않고 바로 "취소" 로 처리하므로
// 화면 안의 시트로 묻는다. 결과: 'save' | 'discard' | 'cancel'
function askUnsaved(actionLabel) {
  return new Promise((resolve) => {
    const sheet = $('unsavedSheet');
    $('discardBtn').textContent = `저장하지 않고 ${actionLabel}`;
    sheet.hidden = false;
    sheet.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b && e.target !== sheet) return; // 시트 바깥(어두운 곳)을 누르면 취소
      sheet.hidden = true;
      sheet.onclick = null;
      resolve(b ? b.dataset.c : 'cancel');
    };
  });
}
/** 저장 안 한 내용이 있으면 물어보고 then() 실행. "저장" 을 고르면 저장이 끝난 뒤에 실행 */
async function guardUnsaved(actionLabel, then) {
  if (S.composing) ime.blur();
  if (!S.dirty) { then(); return; }
  const choice = await askUnsaved(actionLabel);
  if (choice === 'discard') then();
  else if (choice === 'save') { S.afterSave = then; openSaveMenu(); }
}

function loadDocument(doc, name) {
  S.doc = doc;
  S.name = name || '새 문서.hwp';
  S.fmt = extOf(S.name) === 'hwpx' ? 'hwpx' : 'hwp';
  S.undo = []; S.redo = []; S.lastKind = '';
  for (const p of S.pages) { observer.unobserve(p.el); p.el.remove(); }
  S.pages = []; S.visible.clear();
  S.fit = true;
  $('empty').hidden = true;
  $('docName').textContent = S.name;
  setDirty(false);
  updateUndoButtons();
  syncPages();
  scroller.scrollTop = 0;
  S.pos = { k: 'b', s: 0, p: 0, o: 0 };
  // 첫 쪽은 바로 그림 (observer 를 기다리지 않음)
  if (S.pages.length) { renderPage(0); S.visible.add(0); }
  placeCaret(false);
}

function openBytes(bytes, name) {
  busy(true, '여는 중…');
  setTimeout(() => {
    try {
      const doc = new HwpDocument(bytes);
      loadDocument(doc, name);
      toast(`${S.pages.length}쪽 · 문서를 눌러 편집하세요`);
    } catch (e) {
      toast(`열 수 없는 문서예요: ${String(e.message || e)}`, 4000);
    } finally {
      busy(false);
    }
  }, 30);
}

function openFile() {
  guardUnsaved('열기', () => { if (host) host.openFile(); else $('fileInput').click(); });
}
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
});

function newDocument() {
  guardUnsaved('새 문서 만들기', createNewDocument);
}
function createNewDocument() {
  try {
    const doc = HwpDocument.createEmpty();
    E(doc.createBlankDocument());
    loadDocument(doc, '새 문서.hwp');
    focusIme();
  } catch (e) {
    toast(`새 문서를 만들지 못했어요: ${String(e.message || e)}`);
  }
}

function openSaveMenu() {
  if (!S.doc) { toast('먼저 문서를 열어 주세요'); return; }
  $('saveMenu').hidden = false;
}
$('saveMenu').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b && e.target !== $('saveMenu')) return;
  $('saveMenu').hidden = true;
  const fmt = b ? b.dataset.fmt : 'cancel';
  if (fmt === 'cancel') { S.afterSave = null; return; }
  saveAs(fmt === 'same' ? S.fmt : fmt);
});

function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function saveAs(fmt) {
  if (S.composing) ime.blur();
  let bytes;
  try { bytes = fmt === 'hwpx' ? S.doc.exportHwpx() : S.doc.exportHwp(); }
  catch (e) { toast(`저장하지 못했어요: ${String(e.message || e)}`, 4000); return; }
  const base = S.name.replace(/\.(hwpx?|HWPX?)$/, '') || '문서';
  const name = `${base}.${fmt}`;
  const mime = fmt === 'hwpx' ? 'application/hwp+zip' : 'application/x-hwp';
  if (host) {
    host.saveFile(bytesToBase64(bytes), name, mime);
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    onSaved(true, name);
  }
}

function onSaved(ok, nameOrMsg) {
  if (ok) {
    S.name = nameOrMsg || S.name;
    S.fmt = extOf(S.name) === 'hwpx' ? 'hwpx' : 'hwp';
    $('docName').textContent = S.name;
    setDirty(false);
    toast(`저장했어요: ${S.name}`);
    const next = S.afterSave; // "저장하고 종료/열기" 의 나머지
    S.afterSave = null;
    if (next) setTimeout(next, 300);
  } else {
    S.afterSave = null; // 저장 실패·취소면 종료 등은 하지 않음
    if (nameOrMsg) toast(`저장하지 못했어요: ${nameOrMsg}`, 4000);
  }
}

// ---------- 라이선스 보기 (페이지를 떠나지 않고 패널로) ----------
document.addEventListener('click', async (e) => {
  const a = e.target.closest('a[data-doc]');
  if (!a) return;
  e.preventDefault();
  try { $('docText').textContent = await (await fetch(a.dataset.doc)).text(); }
  catch { $('docText').textContent = '불러오지 못했어요'; }
  $('docView').hidden = false;
});
$('docClose').onclick = () => { $('docView').hidden = true; };

// ---------- 확대·축소 ----------
function setZoom(scale, fit) {
  if (!S.doc) return;
  // 확대·축소 후에도 화면 가운데에 보던 곳이 그대로 가운데에 오도록 비율로 기억
  const cx = (scroller.scrollLeft + scroller.clientWidth / 2) / Math.max(pagesBox.scrollWidth, 1);
  const cy = (scroller.scrollTop + scroller.clientHeight / 2) / Math.max(pagesBox.scrollHeight, 1);
  S.fit = fit;
  S.scale = fit ? computeFitScale() : Math.min(4, Math.max(0.2, scale));
  applySizes();
  scroller.scrollLeft = cx * pagesBox.scrollWidth - scroller.clientWidth / 2;
  scroller.scrollTop = cy * pagesBox.scrollHeight - scroller.clientHeight / 2;
  placeCaret(false);
}
$('btnZoomIn').onclick = () => setZoom(S.scale * 1.25, false);
$('btnZoomOut').onclick = () => setZoom(S.scale / 1.25, false);
$('btnZoomFit').onclick = () => setZoom(0, true);
window.addEventListener('resize', () => { if (S.doc && S.fit) setZoom(0, true); });

// ---------- 종료 ----------
/** 문서를 닫고 첫 화면으로 (브라우저에서 시험할 때 종료 대신) */
function closeDocument() {
  for (const p of S.pages) { observer.unobserve(p.el); p.el.remove(); }
  S.pages = []; S.visible.clear();
  S.doc = null; S.pos = null; S.name = '';
  S.undo = []; S.redo = [];
  caretEl.remove(); caretPage = -1;
  ime.blur();
  setDirty(false);
  updateUndoButtons();
  $('docName').textContent = '문서 없음';
  $('empty').hidden = false;
}
function exitApp() {
  guardUnsaved('종료', () => { if (host) host.exit(); else closeDocument(); });
}

// ---------- 버튼 ----------
$('btnExit').onclick = exitApp;
$('btnOpen').onclick = openFile;
$('emptyOpen').onclick = openFile;
$('btnNew').onclick = newDocument;
$('emptyNew').onclick = newDocument;
$('btnSave').onclick = openSaveMenu;
$('btnUndo').onclick = () => { undo(); if (S.pos) focusIme(); };
$('btnRedo').onclick = () => { redo(); if (S.pos) focusIme(); };
// 툴바를 눌러도 입력칸 포커스(키보드)가 빠지지 않게
for (const b of document.querySelectorAll('#bar button')) b.addEventListener('mousedown', (e) => e.preventDefault());
window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------- 안드로이드 앱과 주고받는 함수 ----------
window.hwpApp = {
  /** 앱이 고른 파일을 /__doc__/current 로 넣어 두고 부름 */
  async loadFromHost(name) {
    try {
      const res = await fetch('/__doc__/current', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      openBytes(new Uint8Array(await res.arrayBuffer()), name);
    } catch (e) {
      toast(`파일을 읽지 못했어요: ${String(e.message || e)}`, 4000);
    }
  },
  onSaved,
  /** 뒤로가기: 저장 안 한 내용이 있으면 물어보고 앱을 닫음 */
  handleBack() {
    if (!$('saveMenu').hidden) { $('saveMenu').hidden = true; return; }
    if (!$('docView').hidden) { $('docView').hidden = true; return; }
    if (!$('unsavedSheet').hidden) { $('unsavedSheet').click(); return; } // 열린 확인 창은 취소
    exitApp();
  },
  isDirty: () => S.dirty,
};

// ---------- 시작 ----------
(async () => {
  busy(true, '편집기를 준비하는 중…');
  try {
    await init({ module_or_path: new URL('./engine/rhwp_bg.wasm', import.meta.url) });
    window.hwpApp.ready = true;
    if (host && host.onReady) host.onReady();
  } catch (e) {
    toast(`편집기를 불러오지 못했어요: ${String(e.message || e)}`, 8000);
  } finally {
    busy(false);
  }
})();
