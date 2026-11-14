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
// - 글자 크기: 커서가 있는 문단 전체, 또는 "앞으로 입력할 글자"(넣을 때마다 그 글자에 크기를 매김).
// - 도구 줄(PDF 편집기처럼): 글자 수정·선택·텍스트(글상자)·펜·형광펜·영역 강조·사각형·지우기·이미지·서명·체크
// - 펜 등: 쪽 위에 투명 캔버스를 덮어 손가락으로 그리고, "완료" 를 누르면 그린 부분만 PNG 로 잘라
//   그 자리에 "글 앞으로" 떠 있는 그림(종이 기준 위치)으로 넣음. 그 쪽의 본문 문단에 붙이고, 넣은 뒤 그 쪽·그 자리에
//   그려졌는지, 쪽 수가 그대로인지 확인해서 아니면 되돌림. (표 칸 안 문단에 붙이면 칸 높이가 바뀌어 양식이 틀어짐)
// - 체크(☑ 버튼): 커서 옆의 □ ○ ☐ 를 ▣ ● ☑ 로 바꾸거나 되돌림 — 글자만 바꾸므로 양식 모양이 그대로.
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
  pendingSize: 0,       // "앞으로 입력할 글자" 크기 (HWP 단위: 1pt = 100). 0 이면 없음
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
  if (P.on) redrawAllPenLayers();
  if (T.sel) showSelection();
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
  if (P.on) attachPenLayer(i);
  if (T.sel && T.sel.page === i) p.el.appendChild(selEl);
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
  if (pos.k === 't') return JSON.parse(S.doc.getCursorRectInCell(pos.s, pos.pp, pos.ci, 0, pos.cp, pos.o));
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
  updateSizeLabel();
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
  // 글상자 안 글자: 표 칸과 같은 함수(칸 번호 0)로 다룸
  if (h.isTextBox && Number.isInteger(h.parentParaIndex) && Number.isInteger(h.controlIndex)) {
    return { k: 't', s: h.sectionIndex, pp: h.parentParaIndex, ci: h.controlIndex, cp: h.cellParaIndex || 0, o: h.charOffset };
  }
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
  if (!el || !S.doc || P.on || e.target.closest('#selBox')) return;
  const i = +el.dataset.i;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / S.scale;
  const y = (e.clientY - r.top) / S.scale;
  if (pageTap(i, x, y)) return; // 선택·텍스트·이미지 넣기 등
  let pos = null;
  try { pos = hitAt(i, x, y); } catch (err) { /* 빈 곳 */ }
  if (!pos) return;
  if (pos.unsupported) { toast('이 글상자 안의 글자는 편집할 수 없어요'); return; }
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
  if (pos.k === 't') return S.doc.getCellParagraphLength(pos.s, pos.pp, pos.ci, 0, pos.cp);
  return pos.k === 'b' ? S.doc.getParagraphLength(pos.s, pos.p) : S.doc.getCellParagraphLengthByPath(pos.s, pos.pp, pathJson(pos));
}

/** pos 위치에 글자를 넣고 pos 를 넣은 글자 뒤로 옮김 */
function insertAt(pos, text) {
  const r = pos.k === 'b' ? E(S.doc.insertText(pos.s, pos.p, pos.o, text))
    : pos.k === 't' ? E(S.doc.insertTextInCell(pos.s, pos.pp, pos.ci, 0, pos.cp, pos.o, text))
    : E(S.doc.insertTextInCellByPath(pos.s, pos.pp, pathJson(pos), pos.o, text));
  const start = pos.o;
  pos.o = r.charOffset != null ? r.charOffset : pos.o + text.length;
  if (S.pendingSize && pos.o > start) applyCharProps(pos, start, pos.o, { fontSize: S.pendingSize });
}
/** pos 가 있는 문단의 [start, end) 글자에 서식을 매김 */
function applyCharProps(pos, start, end, props) {
  const json = JSON.stringify(props);
  if (pos.k === 'b') E(S.doc.applyCharFormat(pos.s, pos.p, start, end, json));
  else if (pos.k === 't') E(S.doc.applyCharFormatInCell(pos.s, pos.pp, pos.ci, 0, pos.cp, start, end, json));
  else E(S.doc.applyCharFormatInCellByPath(pos.s, pos.pp, pathJson(pos), start, end, json));
}
/** 커서 자리 글자의 속성 (글자 크기 등) */
function charPropsAt(pos) {
  const len = paraLength(pos);
  const o = Math.max(0, Math.min(pos.o, len) - (pos.o >= len && len > 0 ? 1 : 0));
  return JSON.parse(pos.k === 'b' ? S.doc.getCharPropertiesAt(pos.s, pos.p, o)
    : pos.k === 't' ? S.doc.getCellCharPropertiesAt(pos.s, pos.pp, pos.ci, 0, pos.cp, o)
    : S.doc.getCellCharPropertiesAtByPath(pos.s, pos.pp, pathJson(pos), o));
}
function deleteAt(pos, offset, count) {
  if (count <= 0) return;
  if (pos.k === 'b') E(S.doc.deleteText(pos.s, pos.p, offset, count));
  else if (pos.k === 't') E(S.doc.deleteTextInCell(pos.s, pos.pp, pos.ci, 0, pos.cp, offset, count));
  else E(S.doc.deleteTextInCellByPath(pos.s, pos.pp, pathJson(pos), offset, count));
}
function splitAt(pos) {
  if (pos.k === 'b') {
    const r = E(S.doc.splitParagraph(pos.s, pos.p, pos.o));
    pos.p = r.paraIdx; pos.o = r.charOffset;
  } else if (pos.k === 't') {
    const r = E(S.doc.splitParagraphInCell(pos.s, pos.pp, pos.ci, 0, pos.cp, pos.o));
    pos.cp = r.cellParaIndex != null ? r.cellParaIndex : pos.cp + 1; pos.o = r.charOffset != null ? r.charOffset : 0;
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
  if (pos.k === 't') {
    if (pos.cp === 0) return false;
    const r = E(S.doc.mergeParagraphInCell(pos.s, pos.pp, pos.ci, 0, pos.cp));
    pos.cp = r.cellParaIndex != null ? r.cellParaIndex : pos.cp - 1; pos.o = r.charOffset != null ? r.charOffset : 0;
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
  if (S.pos && S.pos.k === 't') growTextBox(S.pos);
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
  S.pendingSize = 0;
  discardDrawing(); clearSelection(); T.place = null;
  setTool('edit', true);
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
  discardDrawing(); clearSelection(); T.place = null;
  setTool('edit', true);
  S.pendingSize = 0;
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


// ---------- 글자 크기 ----------
const SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48];
let sizeScope = 'para';
const ptText = (hu) => String(Math.round(hu / 10) / 10).replace(/\.0$/, '');

function currentSizeHu() {
  if (!S.doc || !S.pos) return 0;
  try { return charPropsAt(S.pos).fontSize || 0; } catch { return 0; }
}
function updateSizeLabel() {
  const hu = S.pendingSize || currentSizeHu();
  $('szNow').textContent = hu ? ptText(hu) + (S.pendingSize ? '*' : '') : '';
}

function openSizeSheet() {
  if (!S.doc || !S.pos) { toast('먼저 문서를 열고 글자를 고칠 곳을 눌러 주세요'); return; }
  if (P.on) commitPen();
  if (S.composing) ime.blur();
  const cur = currentSizeHu();
  $('sizeCur').textContent = cur ? `· 지금 ${ptText(cur)}pt` : '';
  const grid = $('sizeGrid');
  grid.innerHTML = '';
  for (const pt of SIZES) {
    const b = document.createElement('button');
    b.textContent = String(pt);
    b.dataset.pt = String(pt);
    const target = sizeScope === 'next' && S.pendingSize ? S.pendingSize : cur;
    if (target && Math.abs(target - pt * 100) < 1) b.classList.add('cur');
    grid.appendChild(b);
  }
  setScope(sizeScope);
  $('sizeSheet').hidden = false;
}
function setScope(scope) {
  sizeScope = scope;
  for (const b of $('sizeScope').querySelectorAll('button')) {
    const on = b.dataset.scope === scope;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}
$('sizeScope').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setScope(b.dataset.scope); });
$('sizeSheet').addEventListener('click', (e) => {
  const sheet = $('sizeSheet');
  const b = e.target.closest('button');
  if (e.target === sheet || (b && b.id === 'sizeCancel')) { sheet.hidden = true; focusIme(); return; }
  if (!b || !b.dataset.pt) return;
  sheet.hidden = true;
  applySize(+b.dataset.pt);
});

function applySize(pt) {
  const hu = Math.round(pt * 100);
  if (sizeScope === 'next') {
    S.pendingSize = hu;
    toast(`이제 입력하는 글자는 ${pt}pt 로 들어가요`);
    updateSizeLabel();
    focusIme();
    return;
  }
  const len = paraLength(S.pos);
  if (!len) {
    // 빈 줄이면 바꿀 글자가 없으니, 이 줄에 입력할 글자 크기로 정함
    S.pendingSize = hu;
    toast(`빈 줄이라 앞으로 입력할 글자를 ${pt}pt 로 할게요`);
    updateSizeLabel();
    focusIme();
    return;
  }
  S.pendingSize = 0;
  edit('format', (pos) => applyCharProps(pos, 0, len, { fontSize: hu }));
  toast(`이 줄 글자를 ${pt}pt 로 바꿨어요`);
  focusIme();
}

// ---------- 체크 표시 (□ ↔ ▣) ----------
const CHECK = { '□': '▣', '▣': '□', '■': '□', '☐': '☑', '☑': '☐', '☒': '☐', '○': '●', '●': '○', '◯': '●' };
function charAt(pos, off) {
  if (off < 0 || off >= paraLength(pos)) return '';
  if (pos.k === 't') return S.doc.getTextInCell(pos.s, pos.pp, pos.ci, 0, pos.cp, off, 1);
  return pos.k === 'b' ? S.doc.getTextRange(pos.s, pos.p, off, 1) : S.doc.getTextInCellByPath(pos.s, pos.pp, pathJson(pos), off, 1);
}
function toggleCheck() {
  if (!S.doc || !S.pos) { toast('먼저 체크할 □ 를 눌러 주세요'); return; }
  if (P.on) { toast('펜을 끝낸 뒤에 써 주세요'); return; }
  if (S.composing) ime.blur();
  let at = -1;
  for (const off of [S.pos.o, S.pos.o - 1]) if (CHECK[charAt(S.pos, off)]) { at = off; break; }
  if (at < 0) { toast('체크할 □ 바로 옆을 누른 다음 ☑ 버튼을 눌러 주세요'); return; }
  const to = CHECK[charAt(S.pos, at)];
  edit('check', (pos) => {
    const keep = pos.o;
    const pending = S.pendingSize;
    S.pendingSize = 0; // 체크 글자는 원래 크기 그대로
    try {
      deleteAt(pos, at, 1);
      const p2 = clone(pos); p2.o = at;
      insertAt(p2, to);
    } finally { S.pendingSize = pending; }
    pos.o = keep;
  });
  toast(to === '□' || to === '☐' || to === '○' ? '체크를 풀었어요' : '체크했어요');
}

/**
 * 손가락을 떼는 순간에 반응하는 버튼 (그림을 그린 직후에는 브라우저가 click 을 한동안 보내지 않는 경우가 있어서).
 * 마우스는 평소처럼 click. 같은 누름에 두 번 반응하지 않게 막음.
 */
let lastTapAt = 0, lastTapX = 0, lastTapY = 0;
function onTap(el, fn) {
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    lastTapAt = performance.now(); lastTapX = e.clientX; lastTapY = e.clientY;
    fn(e);
  });
  el.addEventListener('click', (e) => { if (performance.now() - lastTapAt < 700) return; fn(e); });
}
// 손가락을 뗄 때 이미 처리했으면, 뒤따라오는 click 은 버림 — 창이 닫힌 뒤 그 아래 문서가 눌리지 않게
document.addEventListener('click', (e) => {
  // 같은 누름에서 나온 click 만 (시간이 짧고 자리가 같을 때) 버림. 다른 곳을 바로 누른 것은 그대로 둠
  if (performance.now() - lastTapAt < 700 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 24) { e.stopPropagation(); e.preventDefault(); }
}, true);

// ---------- 도구 (PDF 편집기처럼: 글자 수정·선택·텍스트·펜·형광펜·영역 강조·사각형·지우기·이미지·서명·체크) ----------
// 펜·형광펜·영역 강조·사각형·지우기는 쪽 위에 투명 캔버스를 덮어 그리고, "완료"(또는 다른 도구로 바꿀 때)에
// 쪽마다 그린 부분만 PNG 로 잘라 "글 앞으로" 떠 있는 그림(종이 기준 위치)으로 넣음.
// 이미지·서명도 같은 방법으로 누른 자리에 넣고, 텍스트는 테두리 없는 글상자를 누른 자리에 만듦.
// 넣을 때는 그 쪽의 본문 문단에 붙이고, 넣은 뒤 그 쪽·그 자리에 그려졌는지, 쪽 수가 그대로인지 확인해서 아니면 되돌림.
// (표 칸 안 문단에 붙이면 칸 높이가 바뀌어 양식이 틀어지므로 쓰지 않음)
const TOOLS = {
  edit: { hint: '문서를 누르면 그 자리에 커서가 놓여요 · 바로 글자를 고칠 수 있어요' },
  select: { hint: '그림·글상자를 눌러 고르세요 · 끌어서 옮기기 · ◢ 로 크기 · 🗑 로 지우기' },
  text: { hint: '글자를 넣을 곳을 누르세요 (테두리 없는 글상자가 생겨요)' },
  pen: { draw: true, hint: '손가락으로 그리세요 · 화면 옮기기는 두 손가락 · 다 그리면 "완료"',
    colors: ['#111827', '#1d4ed8', '#dc2626'], widths: [1.5, 2.5, 4], alpha: 1 },
  hl: { draw: true, hint: '형광펜으로 칠하세요 · 다 칠하면 "완료"',
    colors: ['#facc15', '#4ade80', '#f472b6'], widths: [10, 16, 24], alpha: 0.4 },
  area: { draw: true, rect: true, fill: true, hint: '끌어서 강조할 영역을 고르세요',
    colors: ['#facc15', '#4ade80', '#f472b6', '#60a5fa'], alpha: 0.35 },
  rect: { draw: true, rect: true, hint: '끌어서 사각형을 그리세요',
    colors: ['#dc2626', '#1d4ed8', '#111827'], widths: [1.5, 2.5, 4], alpha: 1 },
  erase: { draw: true, rect: true, fill: true, hint: '끌어서 가릴 영역을 고르세요 (흰색으로 덮어요)', colors: ['#ffffff'], alpha: 1 },
  image: { hint: '그림을 넣을 곳을 누르세요' },
  sign: { hint: '서명을 넣을 곳을 누르세요' },
};
const T = { tool: 'edit', place: null, sel: null, style: {} };
// 그리기 상태
const P = {
  on: false,
  items: new Map(),     // 쪽 번호 → [{kind:'stroke'|'rect', color, alpha, width, fill, pts | x0,y0,x1,y1}] (쪽 좌표)
  history: [],          // 그린 순서 [{page, item}] — "획 지우기" 용
  layers: new Map(),    // 쪽 번호 → canvas
  pointers: new Map(),  // pointerId → {x, y, page, item}
  pan: null,            // 두 손가락으로 화면 옮기는 중이면 {x, y}
};
// 예전 이름 (다른 곳에서 씀)
const exitPen = () => { discardDrawing(); setTool('edit', true); };
const cancelPen = () => { const had = P.history.length > 0; exitPen(); if (had) toast('그린 것을 넣지 않았어요'); };
const commitPen = () => finishDrawing().then(() => setTool('edit', true));

function styleFor(tool) {
  const d = TOOLS[tool];
  if (!T.style[tool]) T.style[tool] = { color: d.colors[0], width: d.widths ? d.widths[Math.min(1, d.widths.length - 1)] : 0 };
  return T.style[tool];
}

/** 도구 바꾸기. 그리던 것이 있으면 넣고 바꿈 */
async function setTool(tool, quiet) {
  if (!TOOLS[tool]) return;
  const prev = T.tool;
  if (TOOLS[prev].draw && !TOOLS[tool].draw && P.history.length) await finishDrawing();
  if (prev === 'select' && tool !== 'select') clearSelection();
  if ((prev === 'image' || prev === 'sign') && tool !== prev) T.place = null;
  T.tool = tool;
  document.body.dataset.tool = tool;
  for (const b of document.querySelectorAll('#tools button[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  $('hint').textContent = TOOLS[tool].hint;
  const draw = !!TOOLS[tool].draw;
  if (draw && !P.on) {
    if (S.composing) ime.blur();
    ime.blur();
    P.on = true;
    for (let i = 0; i < S.pages.length; i++) attachPenLayer(i);
  } else if (!draw && P.on) {
    P.on = false;
    for (const c of P.layers.values()) c.remove();
    P.layers.clear(); P.pointers.clear(); P.pan = null;
  }
  $('penBar').hidden = !draw;
  document.body.classList.toggle('drawing', draw);
  if (draw) buildPenBar(tool);
  if (tool !== 'edit') ime.blur();
  document.body.classList.toggle('penOn', tool !== 'edit');
}

function buildPenBar(tool) {
  const d = TOOLS[tool], st = styleFor(tool);
  const row = $('penStyle');
  row.innerHTML = '';
  if (d.colors.length > 1) for (const c of d.colors) {
    const b = document.createElement('button');
    b.className = 'pc' + (c === st.color ? ' on' : '');
    b.style.setProperty('--c', c);
    b.dataset.color = c;
    b.setAttribute('aria-label', '색');
    row.appendChild(b);
  }
  if (d.widths) {
    if (row.children.length) { const v = document.createElement('span'); v.className = 'vsep'; row.appendChild(v); }
    for (const w of d.widths) {
      const b = document.createElement('button');
      b.className = 'pw' + (w === st.width ? ' on' : '');
      b.dataset.w = String(w);
      b.setAttribute('aria-label', `굵기 ${w}`);
      const i = document.createElement('i');
      i.style.height = `${Math.max(2, Math.min(8, w * (tool === 'hl' ? 0.35 : 1.4)))}px`;
      b.appendChild(i);
      row.appendChild(b);
    }
  }
  row.hidden = !row.children.length;
}
onTap($('penStyle'), (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const st = styleFor(T.tool);
  if (b.dataset.color) st.color = b.dataset.color;
  if (b.dataset.w) st.width = +b.dataset.w;
  buildPenBar(T.tool);
});

function discardDrawing() {
  P.items.clear(); P.history = []; P.pointers.clear(); P.pan = null;
  for (const i of P.layers.keys()) redrawPenLayer(i);
}

function attachPenLayer(i) {
  const p = S.pages[i];
  if (!p) return;
  let c = P.layers.get(i);
  if (!c) {
    c = document.createElement('canvas');
    c.className = 'penLayer';
    c.dataset.i = String(i);
    c.width = 0; c.height = 0; // 실제 그림판 크기는 처음 그릴 때 정함 (쪽이 많아도 가볍게)
    c.addEventListener('pointerdown', onPenDown);
    c.addEventListener('pointermove', onPenMove);
    c.addEventListener('pointerup', onPenUp);
    c.addEventListener('pointercancel', onPenUp);
    P.layers.set(i, c);
  }
  if (c.parentNode !== p.el) p.el.appendChild(c);
  if (P.items.has(i)) redrawPenLayer(i);
}
function sizeLayer(i) {
  const c = P.layers.get(i); const p = S.pages[i];
  const dpr = window.devicePixelRatio || 1;
  // 너무 큰 그림판은 메모리를 많이 써서 한 변 4096 으로 제한
  const k = Math.min(S.scale * dpr, 4096 / Math.max(p.w, p.h, 1));
  const w = Math.round(p.w * k), h = Math.round(p.h * k);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0);
  return g;
}
function drawItem(g, it) {
  g.save();
  g.globalAlpha = it.alpha;
  g.strokeStyle = it.color; g.fillStyle = it.color; g.lineWidth = it.width;
  g.lineCap = 'round'; g.lineJoin = 'round';
  if (it.kind === 'rect') {
    const x = Math.min(it.x0, it.x1), y = Math.min(it.y0, it.y1), w = Math.abs(it.x1 - it.x0), h = Math.abs(it.y1 - it.y0);
    if (it.fill) g.fillRect(x, y, w, h); else g.strokeRect(x, y, w, h);
    // 흰색 지우기는 화면에서 알아보게 테두리를 살짝 그림 (넣는 그림에는 안 들어감)
    if (it.preview && it.color === '#ffffff') { g.globalAlpha = 1; g.strokeStyle = '#94a3b8'; g.lineWidth = 1; g.setLineDash([4, 3]); g.strokeRect(x, y, w, h); }
  } else {
    const pts = it.pts;
    if (pts.length === 1) { g.beginPath(); g.arc(pts[0][0], pts[0][1], it.width / 2, 0, Math.PI * 2); g.fill(); }
    else { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let j = 1; j < pts.length; j++) g.lineTo(pts[j][0], pts[j][1]); g.stroke(); }
  }
  g.restore();
}
function redrawPenLayer(i) {
  const c = P.layers.get(i);
  if (!c) return;
  const g = sizeLayer(i);
  g.clearRect(0, 0, S.pages[i].w, S.pages[i].h);
  for (const it of P.items.get(i) || []) drawItem(g, { ...it, preview: true });
}
function redrawAllPenLayers() { for (const i of P.layers.keys()) redrawPenLayer(i); }

function pagePoint(e) {
  const r = e.currentTarget.getBoundingClientRect();
  return [(e.clientX - r.left) / S.scale, (e.clientY - r.top) / S.scale];
}
function onPenDown(e) {
  e.preventDefault();
  const i = +e.currentTarget.dataset.i;
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
  P.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, page: i, item: null });
  if (P.pointers.size >= 2) {
    // 두 손가락: 그리던 것은 취소하고 화면 옮기기
    for (const ptr of P.pointers.values()) if (ptr.item) removeItem(ptr.page, ptr.item);
    for (const ptr of P.pointers.values()) ptr.item = null;
    P.pan = midpoint();
    return;
  }
  const d = TOOLS[T.tool], st = styleFor(T.tool);
  const [x, y] = pagePoint(e);
  const it = d.rect
    ? { kind: 'rect', color: st.color, alpha: d.alpha, width: st.width || 0, fill: !!d.fill, x0: x, y0: y, x1: x, y1: y }
    : { kind: 'stroke', color: st.color, alpha: d.alpha, width: st.width, pts: [[x, y]] };
  if (!P.items.has(i)) P.items.set(i, []);
  P.items.get(i).push(it);
  P.history.push({ page: i, item: it });
  P.pointers.get(e.pointerId).item = it;
  redrawPenLayer(i);
}
function onPenMove(e) {
  const ptr = P.pointers.get(e.pointerId);
  if (!ptr) return;
  e.preventDefault();
  ptr.x = e.clientX; ptr.y = e.clientY;
  if (P.pan) {
    const m = midpoint();
    scroller.scrollLeft -= m.x - P.pan.x;
    scroller.scrollTop -= m.y - P.pan.y;
    P.pan = m;
    return;
  }
  const it = ptr.item;
  if (!it) return;
  const [x, y] = pagePoint(e);
  if (it.kind === 'rect') { it.x1 = x; it.y1 = y; }
  else {
    const [lx, ly] = it.pts[it.pts.length - 1];
    if (Math.hypot(x - lx, y - ly) < 0.6) return;
    it.pts.push([x, y]);
  }
  redrawPenLayer(ptr.page);
}
function onPenUp(e) {
  const ptr = P.pointers.get(e.pointerId);
  P.pointers.delete(e.pointerId);
  if (P.pointers.size < 2) P.pan = null;
  // 너무 작은 사각형(그냥 누른 것)은 버림
  if (ptr && ptr.item && ptr.item.kind === 'rect' && (Math.abs(ptr.item.x1 - ptr.item.x0) < 3 || Math.abs(ptr.item.y1 - ptr.item.y0) < 3)) removeItem(ptr.page, ptr.item);
}
function midpoint() {
  let x = 0, y = 0;
  for (const p of P.pointers.values()) { x += p.x; y += p.y; }
  return { x: x / P.pointers.size, y: y / P.pointers.size };
}
function removeItem(page, it) {
  const list = P.items.get(page) || [];
  const k = list.indexOf(it);
  if (k >= 0) list.splice(k, 1);
  if (!list.length) P.items.delete(page);
  const h = P.history.findIndex((x) => x.item === it);
  if (h >= 0) P.history.splice(h, 1);
  redrawPenLayer(page);
}

onTap($('penUndo'), () => {
  const last = P.history[P.history.length - 1];
  if (!last) { toast('지울 것이 없어요'); return; }
  removeItem(last.page, last.item);
});
onTap($('penCancel'), cancelPen);
onTap($('penDone'), commitPen);

/** 한 쪽에 그린 것들을 감싸는 상자(쪽 좌표)와 PNG */
async function itemsToPng(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of list) {
    const r = it.kind === 'rect' && it.fill ? 0 : it.width / 2 + 1;
    const pts = it.kind === 'rect' ? [[it.x0, it.y0], [it.x1, it.y1]] : it.pts;
    for (const [x, y] of pts) { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); }
  }
  const bw = Math.max(4, x1 - x0), bh = Math.max(4, y1 - y0);
  const k = Math.min(3, 2400 / Math.max(bw, bh)); // 화면보다 선명하게(약 288dpi), 너무 크지 않게
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bw * k)); c.height = Math.max(1, Math.round(bh * k));
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  for (const it of list) drawItem(g, it);
  return { box: { x: x0, y: y0, w: bw, h: bh }, ...(await canvasPng(c)) };
}
async function canvasPng(c) {
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), natW: c.width, natH: c.height, ext: 'png' };
}

/** 그린 것을 문서에 넣음 */
async function finishDrawing() {
  const pages = [...P.items.entries()].filter(([, l]) => l.length);
  if (!pages.length) { discardDrawing(); return; }
  busy(true, '그림을 넣는 중…');
  let imgs;
  try {
    imgs = await Promise.all(pages.map(async ([i, list]) => ({ i, ...(await itemsToPng(list)) })));
  } catch (e) {
    busy(false);
    toast(`그림을 만들지 못했어요: ${String(e.message || e)}`);
    return;
  }
  discardDrawing();
  let ok = 0, fail = 0;
  checkpoint('draw');
  for (const img of imgs) if (insertFloatingPicture(img.i, img, '펜으로 그린 그림')) ok++; else fail++;
  busy(false);
  if (!ok) {
    S.undo.pop(); updateUndoButtons(); // 아무것도 못 넣었으면 되돌리기 기록도 빼고 문서도 그대로
    toast('이 쪽은 통째로 표로 되어 있어 그림을 붙일 곳이 없어요. □ 체크는 □ 를 누르고 "체크"를 쓰세요', 5000);
    return;
  }
  afterEdit(false);
  toast(fail ? `그림 ${ok}개를 넣었어요 (${fail}쪽은 표로만 되어 있어 넣지 못했어요)` : '문서에 넣었어요 · 되돌리기(↶)로 뺄 수 있어요', 3500);
}

/** 쪽 SVG 안의 그림 목록 (넣은 그림을 찾아 실제 자리를 확인하는 데 씀) */
function pageImages(i) {
  const svg = S.doc.renderPageSvg(i);
  const out = [];
  const re = /<image x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
  let m;
  while ((m = re.exec(svg))) out.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], key: m[0] });
  return out;
}
/** before 에 없던, 크기가 box 와 같은 그림을 찾음 */
function findNewImage(i, before, box) {
  const left = new Map();
  for (const b of before) left.set(b.key, (left.get(b.key) || 0) + 1);
  for (const im of pageImages(i)) {
    const n = left.get(im.key) || 0;
    if (n > 0) { left.set(im.key, n - 1); continue; }
    if (Math.abs(im.w - box.w) < 1.5 && Math.abs(im.h - box.h) < 1.5) return im;
  }
  return null;
}

/** 문단 시작이 놓인 쪽 번호 (못 구하면 -1) */
function paraStartPage(sec, pi) {
  try { return JSON.parse(S.doc.getCursorRect(sec, pi, 0)).pageIndex; } catch { return -1; }
}
/**
 * 개체를 붙일 본문 문단 후보: 그 쪽에서 시작하는 문단들(앞쪽부터), 그리고 앞 쪽에서 시작해 이 쪽까지 이어진 문단.
 * 문단 시작 쪽은 문서 순서대로 늘어나므로 이분 탐색으로 찾음.
 */
function anchorParas(page) {
  const out = [];
  const nSec = S.doc.getSectionCount ? S.doc.getSectionCount() : 1;
  for (let sec = 0; sec < nSec && out.length < 5; sec++) {
    const n = S.doc.getParagraphCount(sec);
    if (!n) continue;
    let lo = 0, hi = n; // 시작 쪽이 page 이상인 첫 문단
    while (lo < hi) { const mid = (lo + hi) >> 1; const pg = paraStartPage(sec, mid); if (pg >= 0 && pg < page) lo = mid + 1; else hi = mid; }
    for (let pi = lo; pi < n && out.length < 4; pi++) {
      if (paraStartPage(sec, pi) !== page) break;
      out.push({ s: sec, p: pi });
    }
    if (lo > 0) out.push({ s: sec, p: lo - 1 });
  }
  return out;
}

const near = (a, b) => Math.abs(a - b) < 1.5;
const FRONT = JSON.stringify({ textWrap: 'InFrontOfText', allowOverlap: true });

/**
 * 그림을 page 의 box 자리에 종이 기준으로 "글 앞으로" 띄워 넣음.
 * 성공하면 {s, p, ci} (넣은 그림), 실패하면 null (문서는 그대로)
 */
function insertFloatingPicture(page, img, desc) {
  for (const anchor of anchorParas(page)) {
    const { box, bytes, natW, natH, ext } = img;
    const snap = S.doc.saveSnapshot();
    const before = pageImages(page);
    const pages = S.doc.pageCount();
    try {
      const r = E(S.doc.insertPicture(anchor.s, anchor.p, 0, '', bytes, Math.round(box.w * 75), Math.round(box.h * 75), // 1px = 75 HWPUNIT
        natW, natH, ext || 'png', desc, Math.round(box.x * 75), Math.round(box.y * 75)));
      E(S.doc.setPictureProperties(anchor.s, r.paraIdx, r.controlIdx, FRONT));
      const a = findNewImage(page, before, box);
      if (a && near(a.x, box.x) && near(a.y, box.y) && S.doc.pageCount() === pages) return { s: anchor.s, p: r.paraIdx, ci: r.controlIdx };
    } catch { /* 아래에서 되돌림 */ }
    try { S.doc.restoreSnapshot(snap); } catch { /* 무시 */ }
  }
  return null;
}

// ---------- 텍스트 (글상자) ----------
function controlsOn(page) {
  try { return (JSON.parse(S.doc.getPageControlLayout(page)).controls || []).filter((c) => c.type !== 'table'); } catch { return []; }
}
function findControl(page, s, p, ci) {
  return controlsOn(page).find((c) => c.secIdx === s && c.paraIdx === p && c.controlIdx === ci) || null;
}

function createTextBoxAt(page, x, y) {
  const pg = S.pages[page];
  const w = Math.max(80, Math.min(320, pg.w - x - 24));
  const h = 26;
  const box = { x, y: y - h / 2 };
  checkpoint('text');
  for (const a of anchorParas(page)) {
    const snap = S.doc.saveSnapshot();
    const pages = S.doc.pageCount();
    try {
      const r = E(S.doc.createShapeControl(JSON.stringify({
        sectionIdx: a.s, paraIdx: a.p, charOffset: 0, width: Math.round(w * 75), height: Math.round(h * 75),
        horzOffset: Math.round(box.x * 75), vertOffset: Math.round(box.y * 75), treatAsChar: false, textWrap: 'InFrontOfText', shapeType: 'textbox',
      })));
      E(S.doc.setShapeProperties(a.s, r.paraIdx, r.controlIdx, JSON.stringify({ lineType: 0, borderWidth: 0, fillType: 'none', allowOverlap: true })));
      const c = findControl(page, a.s, r.paraIdx, r.controlIdx);
      if (c && S.doc.pageCount() === pages && Math.abs(c.x - box.x) < 8 && Math.abs(c.y - box.y) < 8) {
        S.pos = { k: 't', s: a.s, pp: r.paraIdx, ci: r.controlIdx, cp: 0, o: 0 };
        setDirty(true);
        syncPages(); renderVisible();
        setTool('edit', true);
        placeCaret(false);
        focusIme();
        toast('글자를 입력하세요 · 크기·위치는 "선택"으로 바꿔요');
        return;
      }
    } catch { /* 다음 후보 */ }
    try { S.doc.restoreSnapshot(snap); } catch { /* 무시 */ }
  }
  S.undo.pop(); updateUndoButtons();
  toast('이 쪽에는 글상자를 넣을 수 없어요 (쪽 전체가 표예요)', 4000);
}

/** 글상자에 글이 넘치면 높이를 늘림 */
function growTextBox(pos) {
  try {
    const n = S.doc.getCellParagraphCount(pos.s, pos.pp, pos.ci, 0);
    const last = { ...pos, cp: n - 1, o: S.doc.getCellParagraphLength(pos.s, pos.pp, pos.ci, 0, n - 1) };
    const r = cursorRect(last);
    const c = findControl(r.pageIndex, pos.s, pos.pp, pos.ci);
    if (!c) return;
    const need = r.y + r.height + 8 - c.y;
    if (need > c.h + 0.5) {
      E(S.doc.setShapeProperties(pos.s, pos.pp, pos.ci, JSON.stringify({ height: Math.round(need * 75) })));
      syncPages(); renderVisible();
    }
  } catch { /* 무시 */ }
}

// ---------- 선택 (그림·글상자 옮기기·크기·지우기) ----------
const selEl = document.createElement('div');
selEl.id = 'selBox';
selEl.innerHTML = '<button class="selDel" aria-label="지우기">🗑</button><div class="selHandle" aria-label="크기"></div>';

function selectAt(page, x, y) {
  const list = controlsOn(page).filter((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
  const c = list[list.length - 1];
  if (!c) { clearSelection(); toast('여기에는 고를 그림·글상자가 없어요'); return; }
  T.sel = { page, type: c.type === 'shape' ? 'shape' : 'image', s: c.secIdx, p: c.paraIdx, ci: c.controlIdx, x: c.x, y: c.y, w: c.w, h: c.h };
  showSelection();
}
function showSelection() {
  const t = T.sel;
  if (!t || !S.pages[t.page]) { selEl.remove(); return; }
  selEl.style.left = `${t.x * S.scale}px`; selEl.style.top = `${t.y * S.scale}px`;
  selEl.style.width = `${t.w * S.scale}px`; selEl.style.height = `${t.h * S.scale}px`;
  if (selEl.parentNode !== S.pages[t.page].el) S.pages[t.page].el.appendChild(selEl);
}
function clearSelection() { T.sel = null; selEl.remove(); }
function refreshSelection() {
  const t = T.sel;
  if (!t) return;
  const c = findControl(t.page, t.s, t.p, t.ci);
  if (!c) { clearSelection(); return; }
  Object.assign(t, { x: c.x, y: c.y, w: c.w, h: c.h });
  showSelection();
}
function getObjProps(t) {
  return JSON.parse(t.type === 'shape' ? S.doc.getShapeProperties(t.s, t.p, t.ci) : S.doc.getPictureProperties(t.s, t.p, t.ci));
}
function setObjProps(t, props) {
  const j = JSON.stringify(props);
  E(t.type === 'shape' ? S.doc.setShapeProperties(t.s, t.p, t.ci, j) : S.doc.setPictureProperties(t.s, t.p, t.ci, j));
}

let selDrag = null;
selEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.selDel')) return;
  e.preventDefault(); e.stopPropagation();
  try { selEl.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
  selDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, resize: !!e.target.closest('.selHandle'), dx: 0, dy: 0, w: T.sel.w, h: T.sel.h };
});
selEl.addEventListener('pointermove', (e) => {
  if (!selDrag || e.pointerId !== selDrag.id) return;
  e.preventDefault();
  const t = T.sel;
  const dx = (e.clientX - selDrag.x) / S.scale, dy = (e.clientY - selDrag.y) / S.scale;
  if (selDrag.resize) {
    let w = Math.max(10, selDrag.w + dx), h = Math.max(10, selDrag.h + dy);
    if (t.type === 'image') h = w * (selDrag.h / selDrag.w); // 그림은 비율 유지
    selDrag.nw = w; selDrag.nh = h;
    selEl.style.width = `${w * S.scale}px`; selEl.style.height = `${h * S.scale}px`;
  } else {
    selDrag.dx = dx; selDrag.dy = dy;
    selEl.style.left = `${(t.x + dx) * S.scale}px`; selEl.style.top = `${(t.y + dy) * S.scale}px`;
  }
});
function endSelDrag(e) {
  if (!selDrag || e.pointerId !== selDrag.id) return;
  const d = selDrag; selDrag = null;
  const t = T.sel;
  const moved = Math.abs(d.dx) > 0.5 || Math.abs(d.dy) > 0.5;
  const resized = d.nw != null && (Math.abs(d.nw - d.w) > 0.5 || Math.abs(d.nh - d.h) > 0.5);
  if (!moved && !resized) { showSelection(); return; }
  checkpoint(resized ? 'resize' : 'move');
  try {
    const pr = getObjProps(t);
    if (resized) setObjProps(t, { width: Math.round(d.nw * 75), height: Math.round(d.nh * 75) });
    else setObjProps(t, { horzOffset: (pr.horzOffset || 0) + Math.round(d.dx * 75), vertOffset: (pr.vertOffset || 0) + Math.round(d.dy * 75) });
  } catch (err) { toast(`바꾸지 못했어요: ${String(err.message || err)}`); }
  setDirty(true); syncPages(); renderVisible();
  refreshSelection();
}
selEl.addEventListener('pointerup', endSelDrag);
selEl.addEventListener('pointercancel', endSelDrag);
selEl.querySelector('.selDel').addEventListener('click', (e) => {
  e.stopPropagation();
  const t = T.sel;
  if (!t) return;
  checkpoint('delete');
  try { E(t.type === 'shape' ? S.doc.deleteShapeControl(t.s, t.p, t.ci) : S.doc.deletePictureControl(t.s, t.p, t.ci)); toast('지웠어요 · 되돌리기(↶)로 살릴 수 있어요'); }
  catch (err) { toast(`지우지 못했어요: ${String(err.message || err)}`); }
  clearSelection();
  if (S.pos && S.pos.k === 't' && S.pos.pp === t.p) S.pos = { k: 'b', s: t.s, p: t.p, o: 0 };
  setDirty(true); syncPages(); renderVisible();
});

// ---------- 이미지 · 서명 넣기 ----------
async function prepareImage(bytes, mime) {
  const blob = new Blob([bytes], { type: mime || 'image/*' });
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)); // 큰 사진은 줄여서 문서가 너무 커지지 않게
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const keepAlpha = /png|webp|gif/i.test(mime || '');
  if (keepAlpha) return canvasPng(c);
  const jb = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
  return { bytes: new Uint8Array(await jb.arrayBuffer()), natW: c.width, natH: c.height, ext: 'jpg' };
}
function startPlacing(kind, img, widthPx) {
  const pgW = Math.max(...S.pages.map((p) => p.w), 400);
  const w = Math.min(widthPx, pgW * 0.6);
  T.place = { ...img, w, h: w * (img.natH / img.natW), label: kind === 'sign' ? '서명' : '그림' };
  setTool(kind);
}
function placeAt(page, x, y) {
  const pl = T.place;
  if (!pl) return;
  const pg = S.pages[page];
  const box = { x: Math.max(0, Math.min(pg.w - pl.w, x - pl.w / 2)), y: Math.max(0, Math.min(pg.h - pl.h, y - pl.h / 2)), w: pl.w, h: pl.h };
  checkpoint('image');
  const r = insertFloatingPicture(page, { ...pl, box }, pl.label === '서명' ? '서명' : '그림');
  if (!r) {
    S.undo.pop(); updateUndoButtons();
    toast('이 쪽에는 넣을 수 없어요 (쪽 전체가 표예요). 다른 쪽에 넣어 보세요', 4000);
    return;
  }
  T.place = null;
  setDirty(true); syncPages(); renderVisible();
  setTool('select', true);
  const c = findControl(page, r.s, r.p, r.ci);
  if (c) { T.sel = { page, type: 'image', s: r.s, p: r.p, ci: r.ci, x: c.x, y: c.y, w: c.w, h: c.h }; showSelection(); }
  toast(`${pl.label}을 넣었어요 · 끌어서 옮기고 ◢ 로 크기를 바꿀 수 있어요`, 3500);
}

function pickImage() {
  if (!S.doc) { toast('먼저 문서를 열어 주세요'); return; }
  if (host && host.pickImage) host.pickImage(); else $('imageInput').click();
}
async function onImageBytes(bytes, mime) {
  try { startPlacing('image', await prepareImage(bytes, mime), 240); }
  catch (e) { toast(`그림을 읽지 못했어요: ${String(e.message || e)}`); }
}
$('imageInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) onImageBytes(new Uint8Array(await f.arrayBuffer()), f.type);
});

// 서명: 손으로 그린 서명을 저장해 두고 다시 씀 (이 휴대폰 안에만 저장)
const SIGN_KEY = 'hwpEditor.signatures';
function loadSigns() { try { return JSON.parse(localStorage.getItem(SIGN_KEY) || '[]'); } catch { return []; } }
function saveSigns(list) { try { localStorage.setItem(SIGN_KEY, JSON.stringify(list.slice(0, 5))); } catch { /* 저장 공간 없음 */ } }
const signPad = { strokes: [], cur: null };
function openSignSheet() {
  if (!S.doc) { toast('먼저 문서를 열어 주세요'); return; }
  const c = $('signPad');
  const w = Math.min(window.innerWidth - 32, 480);
  c.style.width = `${w}px`; c.style.height = `${Math.round(w * 0.42)}px`;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr); c.height = Math.round(w * 0.42 * dpr);
  signPad.strokes = []; signPad.cur = null;
  drawSignPad();
  const list = $('signList');
  list.innerHTML = '';
  for (const [i, url] of loadSigns().entries()) {
    const b = document.createElement('button');
    b.className = 'signItem';
    b.dataset.i = String(i);
    b.innerHTML = `<img alt="저장된 서명 ${i + 1}" src="${url}"><span class="signDel" data-del="${i}" aria-label="지우기">✕</span>`;
    list.appendChild(b);
  }
  $('signSaved').hidden = !list.children.length;
  $('signSheet').hidden = false;
}
function drawSignPad() {
  const c = $('signPad'); const g = c.getContext('2d');
  const k = c.width / parseFloat(c.style.width);
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
  g.setTransform(k, 0, 0, k, 0, 0);
  for (const st of signPad.strokes) drawItem(g, st);
}
function padPoint(e) { const r = $('signPad').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
$('signPad').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  signPad.cur = { kind: 'stroke', color: '#111827', alpha: 1, width: 3, pts: [padPoint(e)] };
  signPad.strokes.push(signPad.cur); drawSignPad();
});
$('signPad').addEventListener('pointermove', (e) => { if (!signPad.cur) return; e.preventDefault(); signPad.cur.pts.push(padPoint(e)); drawSignPad(); });
const endSign = () => { signPad.cur = null; };
$('signPad').addEventListener('pointerup', endSign);
$('signPad').addEventListener('pointercancel', endSign);
onTap($('signSheet'), async (e) => {
  const sheet = $('signSheet');
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); const l = loadSigns(); l.splice(+del.dataset.del, 1); saveSigns(l); openSignSheet(); return; }
  const item = e.target.closest('.signItem');
  if (item) {
    sheet.hidden = true;
    const url = loadSigns()[+item.dataset.i];
    if (url) startPlacing('sign', await dataUrlImage(url), 150);
    return;
  }
  const b = e.target.closest('button');
  if (e.target === sheet || (b && b.dataset.c === 'cancel')) { sheet.hidden = true; return; }
  if (b && b.dataset.c === 'clear') { signPad.strokes = []; drawSignPad(); return; }
  if (b && b.dataset.c === 'use') {
    if (!signPad.strokes.length) { toast('서명을 그려 주세요'); return; }
    const img = await itemsToPng(signPad.strokes);
    const url = `data:image/png;base64,${bytesToBase64(img.bytes)}`;
    const l = loadSigns().filter((u) => u !== url); l.unshift(url); saveSigns(l);
    sheet.hidden = true;
    startPlacing('sign', img, 150);
  }
});
async function dataUrlImage(url) {
  const bytes = Uint8Array.from(atob(url.split(',')[1]), (ch) => ch.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  return { bytes, natW: bmp.width, natH: bmp.height, ext: 'png' };
}

// ---------- 도구 줄 ----------
$('tools').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (!S.doc) { toast('먼저 문서를 열어 주세요'); return; }
  if (b.dataset.tool) { setTool(b.dataset.tool); if (b.dataset.tool === 'edit' && S.pos) focusIme(); return; }
  if (b.dataset.act === 'image') pickImage();
  else if (b.dataset.act === 'sign') openSignSheet();
  else if (b.dataset.act === 'check') { if (T.tool !== 'edit') setTool('edit', true); toggleCheck(); if (S.pos) focusIme(); }
});
for (const b of document.querySelectorAll('#tools button')) b.addEventListener('mousedown', (e) => e.preventDefault());

/** 쪽을 눌렀을 때 도구별 동작 (글자 수정이 아닐 때) */
function pageTap(i, x, y) {
  if (T.tool === 'select') { selectAt(i, x, y); return true; }
  if (T.tool === 'text') { createTextBoxAt(i, x, y); return true; }
  if ((T.tool === 'image' || T.tool === 'sign') && T.place) { placeAt(i, x, y); return true; }
  return T.tool !== 'edit';
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
$('btnSize').onclick = openSizeSheet;

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
  /** 앱이 고른 그림을 /__img__/current 로 넣어 두고 부름 (mime 이 없으면 취소) */
  async onImagePicked(mime) {
    if (!mime) return;
    try {
      const res = await fetch('/__img__/current', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onImageBytes(new Uint8Array(await res.arrayBuffer()), mime);
    } catch (e) {
      toast(`그림을 읽지 못했어요: ${String(e.message || e)}`, 4000);
    }
  },
  /** 뒤로가기: 저장 안 한 내용이 있으면 물어보고 앱을 닫음 */
  handleBack() {
    if (!$('saveMenu').hidden) { $('saveMenu').hidden = true; return; }
    if (!$('sizeSheet').hidden) { $('sizeSheet').hidden = true; return; }
    if (!$('signSheet').hidden) { $('signSheet').hidden = true; return; }
    if (T.tool !== 'edit') { if (P.history.length) cancelPen(); else setTool('edit', true); return; }
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
