"use strict";

const $ = (id) => document.getElementById(id);
const uid = () => crypto.randomUUID();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let items = [];        // корень: сайты и папки (вложенность — один уровень)
let dim = 30;          // затемнение обоев, %
let openId = null;     // id открытой папки
let dragging = null;   // id перетаскиваемой плитки
let busy = false;      // идёт анимация перехода
let editing = false;   // режим редактирования
let wallAvg = null;    // средний цвет обоев [r,g,b]
let needsSave = false; // первый запуск / миграция: нужно записать данные
let wallUrl = null;
let editCtx = null;
let engines = [];
let engine = null;     // выбранный поисковик (только для этой вкладки)

/* ---------- утилиты ---------- */
function bindPick(inputId) {
  const inp = $(inputId), name = $(inputId + "Name");
  const upd = () => { name.textContent = (inp.files[0] && inp.files[0].name) || "Файл не выбран"; };
  inp.addEventListener("change", upd);
  return upd;
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; }
}

// "example.com" -> "https://example.com"; не похоже на адрес -> null
function normalizeUrl(raw) {
  raw = raw.trim();
  let c = null;
  if (/^https?:\/\//i.test(raw)) c = raw;
  else if (/^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(raw)) c = "https://" + raw;
  if (!c) return null;
  try { new URL(c); return c; } catch { return null; }
}

function hueOf(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function find(id, arr = items) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].id === id) return { arr, idx: i, item: arr[i] };
    if (arr[i].type === "folder") {
      const r = find(id, arr[i].items);
      if (r) return r;
    }
  }
  return null;
}

const currentArr = () => {
  const f = openId && find(openId);
  return f ? f.item.items : items;
};

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const save = () => browser.storage.local.set({ items, dim });

const updIconName = bindPick("tIcon");
const updWallName = bindPick("wallFile");

/* ---------- хранилище ---------- */
async function load() {
  const s = await browser.storage.local.get(["items", "tiles", "dim"]);
  if (typeof s.dim === "number") dim = s.dim;

  if (Array.isArray(s.items)) { items = s.items; return; }

  // миграция с версии 0.1 (плоский список)
  if (Array.isArray(s.tiles)) {
    items = s.tiles.map((t) => ({ id: uid(), type: "site", title: t.title, url: t.url, icon: t.icon || null }));
    await browser.storage.local.remove("tiles");
    needsSave = true;
    return;
  }

  // первый запуск: часто посещаемые сайты
  let top = [];
  try {
    top = await browser.topSites.get({ limit: 8, onePerDomain: true, includeFavicon: true });
  } catch {
    try { top = await browser.topSites.get({ limit: 8, onePerDomain: true }); } catch {}
  }
  needsSave = true;
  items = top
    .filter((t) => /^https?:/.test(t.url))
    .map((t) => ({ id: uid(), type: "site", title: t.title || hostOf(t.url), url: t.url, icon: t.favicon || null }));
}

/* ---------- иконки ---------- */
function eachSite(arr, fn) {
  for (const it of arr) {
    if (it.type === "folder") eachSite(it.items, fn);
    else fn(it);
  }
}

// Иконки раньше брались только при первом запуске. Теперь плиткам без иконки
// на каждом старте пробуем подобрать favicon среди «часто посещаемых» сайтов.
async function syncIcons() {
  const missing = [];
  eachSite(items, (it) => { if (!it.icon) missing.push(it); });
  if (!missing.length) return;

  let top = [];
  try {
    top = await browser.topSites.get({ limit: 100, onePerDomain: true, includeFavicon: true });
  } catch { return; }

  const byHost = new Map();
  for (const t of top) if (t.favicon && /^https?:/.test(t.url)) byHost.set(hostOf(t.url), t.favicon);

  let changed = false;
  for (const it of missing) {
    const f = byHost.get(hostOf(it.url));
    if (f) { it.icon = f; it.custom = false; changed = true; }
  }
  if (changed) {
    await save();
    if (!busy && !dragging) render();
  }
}

function letterFallback(el, item) {
  el.classList.remove("has-img", "custom");
  el.replaceChildren(document.createTextNode((item.title[0] || "?").toUpperCase()));
  el.style.background = `hsl(${hueOf(hostOf(item.url || item.title))} 45% 48%)`;
}

function makeIcon(item, mini = false) {
  const el = document.createElement("div");
  el.className = "ico" + (mini ? " mini" : "");

  if (item.type === "folder") {
    el.classList.add("folder");
    item.items.slice(0, 4).forEach((c) => el.append(makeIcon(c, true)));
    return el;
  }
  if (item.icon) {
    el.classList.add("has-img");
    if (item.custom) el.classList.add("custom");
    const img = document.createElement("img");
    img.src = item.icon;
    img.alt = "";
    img.draggable = false;
    img.addEventListener("error", () => letterFallback(el, item), { once: true });
    el.append(img);
  } else {
    letterFallback(el, item);
  }
  return el;
}

// Загруженную картинку сжимаем до 128×128 и храним как data URL
async function toIconDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const k = Math.max(128 / bmp.width, 128 / bmp.height);   // cover
  const w = bmp.width * k, h = bmp.height * k;
  c.getContext("2d").drawImage(bmp, (128 - w) / 2, (128 - h) / 2, w, h);
  return c.toDataURL("image/png");
}

/* ---------- отрисовка ---------- */
function render() {
  const folder = openId ? find(openId)?.item : null;
  if (openId && !folder) openId = null;

  document.body.classList.toggle("editing", editing);
  $("editBar").hidden = !editing;
  $("eAddFolder").hidden = !!folder;
  $("crumbRename").hidden = !editing;
  $("crumb").hidden = !folder;
  document.querySelector("main").classList.toggle("in-folder", !!folder);
  if (folder) $("crumbTitle").textContent = folder.title;

  fillGrid($("tiles"), currentArr());
}

function fillGrid(grid, arr) {
  const nodes = arr.map((it) => tileEl(it, arr));
  if (!nodes.length) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = editing ? "Здесь пока пусто. Добавьте сайт кнопкой ниже." : "Здесь пока пусто. Нажмите ⚙ → «Редактировать», чтобы добавить плитки.";
    nodes.push(hint);
  }
  grid.replaceChildren(...nodes);

  // бросить плитку в пустое место сетки = в конец текущего списка
  grid.ondragover = (e) => { if (isOurDrag(e)) e.preventDefault(); };
  grid.ondrop = (e) => { e.preventDefault(); dropToEnd(arr); };
}

function tileEl(item, arr) {
  const wrap = document.createElement("div");
  wrap.className = "tile";
  wrap.dataset.id = item.id;
  wrap.draggable = editing;

  let card;
  if (item.type === "folder") {
    card = document.createElement("button");
    card.type = "button";
    card.addEventListener("click", () => navigate(item.id));
  } else {
    card = document.createElement("a");
    card.href = item.url;
    card.draggable = false;
    card.addEventListener("click", (e) => { if (editing) e.preventDefault(); });
  }
  card.className = "card";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = item.title;
  card.append(makeIcon(item), name);

  if (editing) {
    const tools = document.createElement("div");
    tools.className = "tools";

    const edit = toolBtn("edit", "✎", "Изменить", item.title);
    edit.addEventListener("click", () => openItemDialog({ mode: "edit", item }));

    const del = toolBtn("del", "×", "Удалить", item.title);
    del.addEventListener("click", async () => {
      if (item.type === "folder" && item.items.length &&
          !confirm(`Удалить папку «${item.title}» вместе с сайтами внутри (${item.items.length})?`)) return;
      const r = find(item.id);
      if (r) r.arr.splice(r.idx, 1);
      await save();
      render();
    });

    tools.append(edit, del);
    wrap.append(card, tools);
  } else {
    wrap.append(card);
  }

  /* перетаскивание */
  wrap.addEventListener("dragstart", (e) => {
    dragging = item.id;
    e.dataTransfer.setData("application/x-tablo", item.id);
    e.dataTransfer.effectAllowed = "move";
    wrap.classList.add("dragging");
  });
  wrap.addEventListener("dragend", () => { dragging = null; wrap.classList.remove("dragging"); });
  wrap.addEventListener("dragover", (e) => {
    if (!isOurDrag(e) || dragging === item.id) return;
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.add("over");
  });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("over"));
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.remove("over");
    dropOnTile(item, arr);
  });

  return wrap;
}

function toolBtn(kind, glyph, label, itemTitle) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tool " + kind;
  b.textContent = glyph;
  b.title = label;
  b.setAttribute("aria-label", `${label}: ${itemTitle}`);
  return b;
}

/* ---------- переход папка <-> корень с анимацией ---------- */
const centerOf = (r) => [r.left + r.width / 2, r.top + r.height / 2];

function ghostOf(el, rect) {
  const g = el.cloneNode(true);
  g.removeAttribute("draggable");
  g.classList.add("ghost");
  Object.assign(g.style, {
    position: "fixed", left: rect.left + "px", top: rect.top + "px",
    width: rect.width + "px", height: rect.height + "px",
    margin: "0", zIndex: "5", pointerEvents: "none",
  });
  document.body.append(g);
  return g;
}

async function navigate(targetId) {
  if (busy || targetId === openId) return;
  const prevId = openId;
  const animate = !reduced();

  const oldEls = [...$("tiles").querySelectorAll(".tile[data-id]")];
  const oldRects = oldEls.map((el) => el.getBoundingClientRect());
  // «призраки» старых плиток: плавно исчезают поверх уже новой сетки
  const ghosts = animate ? oldEls.map((el, i) => ghostOf(el, oldRects[i])) : [];

  openId = targetId;
  render();
  if (!animate) return;

  busy = true;
  const DUR = 400;
  const EASE = "cubic-bezier(.2,.8,.2,1)";
  const anims = [];
  const newEls = [...$("tiles").querySelectorAll(".tile[data-id]")];

  if (targetId) {
    // открытие: плитки папки «вылетают» из её иконки, остальное растворяется
    const src = oldRects[oldEls.findIndex((el) => el.dataset.id === targetId)];
    const [sx, sy] = centerOf(src);
    newEls.forEach((el) => {
      const [cx, cy] = centerOf(el.getBoundingClientRect());
      anims.push(el.animate(
        [{ transform: `translate(${sx - cx}px, ${sy - cy}px) scale(.35)`, opacity: 0 },
         { transform: "none", opacity: 1 }],
        { duration: DUR, easing: EASE, fill: "backwards" }));
    });
    ghosts.forEach((g, i) => {
      const isSrc = oldEls[i].dataset.id === targetId;
      anims.push(g.animate(
        isSrc ? [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.3)" }]
              : [{ opacity: 1 }, { opacity: 0 }],
        { duration: isSrc ? DUR * 0.8 : 240, easing: "ease-out", fill: "forwards" }));
    });
    anims.push($("crumb").animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR, fill: "backwards" }));
  } else {
    // закрытие: плитки папки «сворачиваются» в её иконку, корень проявляется
    const fEl = newEls.find((el) => el.dataset.id === prevId);
    const [fx, fy] = fEl ? centerOf(fEl.getBoundingClientRect()) : [innerWidth / 2, innerHeight / 2];
    ghosts.forEach((g, i) => {
      const [cx, cy] = centerOf(oldRects[i]);
      anims.push(g.animate(
        [{ transform: "none", opacity: 1 },
         { transform: `translate(${fx - cx}px, ${fy - cy}px) scale(.35)`, opacity: 0 }],
        { duration: DUR, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }));
    });
    newEls.forEach((el) => {
      anims.push(el.animate(
        el === fEl ? [{ opacity: 0, transform: "scale(.7)" }, { opacity: 1, transform: "none" }]
                   : [{ opacity: 0 }, { opacity: 1 }],
        { duration: DUR, delay: el === fEl ? DUR * 0.4 : 80, easing: EASE, fill: "backwards" }));
    });
  }

  await Promise.all(anims.map((a) => a.finished.catch(() => {})));
  ghosts.forEach((g) => g.remove());
  busy = false;
}

$("crumbBack").addEventListener("click", () => navigate(null));
$("crumbRename").addEventListener("click", () => {
  const f = openId && find(openId);
  if (f) openItemDialog({ mode: "edit", item: f.item });
});
// клик по пустому месту страницы закрывает папку
document.addEventListener("click", (e) => {
  if (openId && (e.target === document.body || e.target === document.querySelector("main") || e.target === $("tiles"))) {
    navigate(null);
  }
});

/* ---------- логика перетаскивания ---------- */
const isOurDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("application/x-tablo");

async function finishDrop() {
  dragging = null;
  await save();
  render();
}

function dropOnTile(target, arr) {
  const src = dragging && find(dragging);
  if (!src || src.item.id === target.id) return;

  src.arr.splice(src.idx, 1);
  if (target.type === "folder" && src.item.type === "site") {
    target.items.push(src.item);                    // сайт → внутрь папки
  } else {
    arr.splice(arr.indexOf(target), 0, src.item);   // иначе — вставить перед целью
  }
  finishDrop();
}

function dropToEnd(arr) {
  const src = dragging && find(dragging);
  if (!src) return;
  if (src.item.type === "folder" && arr !== items) return;   // папки в папки не кладём
  src.arr.splice(src.idx, 1);
  arr.push(src.item);
  finishDrop();
}

// кнопка «Назад» в папке — зона, куда можно бросить плитку, чтобы вынести её в корень
$("crumbBack").addEventListener("dragover", (e) => {
  if (isOurDrag(e)) { e.preventDefault(); $("crumbBack").classList.add("over"); }
});
$("crumbBack").addEventListener("dragleave", () => $("crumbBack").classList.remove("over"));
$("crumbBack").addEventListener("drop", (e) => {
  e.preventDefault();
  $("crumbBack").classList.remove("over");
  dropToEnd(items);
});

/* ---------- диалог плитки / папки ---------- */
function openItemDialog(ctx) {
  editCtx = ctx;
  const it = ctx.item;
  const isFolder = (ctx.kind || it.type) === "folder";

  $("dlgTitle").textContent =
    ctx.mode === "add" ? (isFolder ? "Новая папка" : "Новая плитка") : (isFolder ? "Папка" : "Плитка");
  $("rowUrl").hidden = isFolder;
  $("rowIcon").hidden = isFolder;
  $("rowReset").hidden = isFolder || !(it && it.icon);
  $("tUrl").required = !isFolder;

  $("tTitle").value = it ? it.title : "";
  $("tUrl").value = it && it.url ? it.url : "";
  $("tUrl").setCustomValidity("");
  $("tIcon").value = "";
  updIconName();
  $("tIconReset").checked = false;
  $("itemDlg").showModal();
}

$("tUrl").addEventListener("input", () => $("tUrl").setCustomValidity(""));
$("itemCancel").addEventListener("click", () => $("itemDlg").close());

$("itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ctx = editCtx;
  const isFolder = (ctx.kind || ctx.item.type) === "folder";
  const title = $("tTitle").value.trim();
  if (!title) return;

  let url = null;
  if (!isFolder) {
    url = normalizeUrl($("tUrl").value);
    if (!url) {
      $("tUrl").setCustomValidity("Нужен адрес вида example.com");
      $("tUrl").reportValidity();
      return;
    }
  }

  let icon;                                  // undefined = не менять
  const file = $("tIcon").files[0];
  if (file) {
    try { icon = await toIconDataUrl(file); }
    catch { alert("Не удалось прочитать это изображение."); return; }
  } else if ($("tIconReset").checked) {
    icon = null;
  }

  let item = ctx.item;
  if (!item) {
    item = isFolder
      ? { id: uid(), type: "folder", title, items: [] }
      : { id: uid(), type: "site", title, url, icon: null };
    ctx.arr.push(item);
  }
  item.title = title;
  if (!isFolder) {
    item.url = url;
    if (icon !== undefined) { item.icon = icon; item.custom = icon !== null; }
  }

  $("itemDlg").close();
  await save();
  render();
  if (!isFolder) syncIcons();
});

/* ---------- меню шестерёнки ---------- */
function closeMenu() {
  $("menu").hidden = true;
  $("gear").setAttribute("aria-expanded", "false");
}
function toggleMenu() {
  if ($("menu").hidden) {
    $("mEdit").textContent = editing ? "Завершить редактирование" : "Редактировать";
    $("menu").hidden = false;
    $("gear").setAttribute("aria-expanded", "true");
    $("mEdit").focus();
  } else {
    closeMenu();
  }
}
$("gear").addEventListener("click", (e) => { e.stopPropagation(); closeEngMenu(); toggleMenu(); });
$("mEdit").addEventListener("click", () => { closeMenu(); setEditing(!editing); });
const openWallDialog = () => { $("wallFile").value = ""; updWallName(); $("setDlg").showModal(); };
$("mWall").addEventListener("click", () => { closeMenu(); openWallDialog(); });

/* ---------- режим редактирования ---------- */
function setEditing(on) {
  editing = on;
  render();
}
$("eDone").addEventListener("click", () => setEditing(false));
$("eAddSite").addEventListener("click", () => openItemDialog({ mode: "add", kind: "site", arr: currentArr() }));
$("eAddFolder").addEventListener("click", () => openItemDialog({ mode: "add", kind: "folder", arr: items }));
$("eWall").addEventListener("click", openWallDialog);

/* ---------- обои (Blob лежит в IndexedDB) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("tablo", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", mode);
    const req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => res(req.result);
    tx.onerror = () => rej(tx.error);
  });
}

async function averageColor(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return [r / n, g / n, b / n];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const dlt = mx - mn;
  const s = l > 0.5 ? dlt / (2 - mx - mn) : dlt / (mx + mn);
  let h = mx === r ? (g - b) / dlt + (g < b ? 6 : 0) : mx === g ? (b - r) / dlt + 2 : (r - g) / dlt + 4;
  return [h * 60, s, l];
}

// Цвет обводки: оттенок обоев, но светлота противоположна яркости фона (с учётом затемнения)
function applyRing() {
  if (!wallAvg) { document.body.style.removeProperty("--ring"); return; }
  const k = 1 - dim / 100;
  const [r, g, b] = wallAvg;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) * k / 255;
  const [h, s] = rgbToHsl(r, g, b);
  const sat = Math.min(Math.max(s, 0.3), 0.85) * 100;
  const light = lum > 0.45 ? 12 : 90;
  document.body.style.setProperty("--ring", `hsl(${Math.round(h)} ${Math.round(sat)}% ${light}%)`);
}

async function applyWallpaper(blob) {
  if (wallUrl) URL.revokeObjectURL(wallUrl);
  wallUrl = blob ? URL.createObjectURL(blob) : null;
  if (wallUrl) {
    const im = new Image();
    im.src = wallUrl;
    await Promise.race([im.decode().catch(() => {}), delay(800)]);
  }
  $("wall").style.backgroundImage = wallUrl ? `url("${wallUrl}")` : "none";
  document.body.classList.toggle("has-wall", !!blob);
  try { wallAvg = blob ? await averageColor(blob) : null; } catch { wallAvg = null; }
  applyRing();
}

function applyDim() {
  $("dimmer").style.background = `rgba(0,0,0,${dim / 100})`;
  $("dim").value = dim;
  $("dimOut").textContent = dim;
}

$("setClose").addEventListener("click", () => $("setDlg").close());
$("wallFile").addEventListener("change", async () => {
  const f = $("wallFile").files[0];
  if (!f) return;
  try {
    await kv("readwrite", (s) => s.put(f, "wall"));
    applyWallpaper(f);
  } catch {
    alert("Не удалось сохранить обои.");
  }
});
$("wallClear").addEventListener("click", async () => {
  await kv("readwrite", (s) => s.delete("wall"));
  applyWallpaper(null);
});
$("dim").addEventListener("input", () => { dim = +$("dim").value; applyDim(); applyRing(); });
$("dim").addEventListener("change", save);

/* ---------- поиск и выбор поисковой системы ---------- */
function engIcon(e) {
  const box = document.createElement("span");
  box.className = "engico";
  const letter = () => box.replaceChildren(document.createTextNode((e.name[0] || "?").toUpperCase()));
  if (e.favIconUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = e.favIconUrl;
    img.addEventListener("error", letter, { once: true });
    box.append(img);
  } else {
    letter();
  }
  return box;
}

function renderEngines() {
  const cur = engines.find((e) => e.name === engine);
  $("engBtn").hidden = !cur;
  if (!cur) return;

  const caret = document.createElement("span");
  caret.textContent = "▾";
  $("engBtn").replaceChildren(engIcon(cur), caret);
  $("engBtn").title = `Поиск через: ${cur.name}`;
  $("engBtn").setAttribute("aria-label", `Поисковая система: ${cur.name}`);

  $("engMenu").replaceChildren(...engines.map((e) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(e.name === engine));
    const label = document.createElement("span");
    label.textContent = e.name;
    b.append(engIcon(e), label);
    b.addEventListener("click", () => {
      engine = e.name;
      renderEngines();
      closeEngMenu();
      $("q").focus();
    });
    li.append(b);
    return li;
  }));
}

function closeEngMenu() {
  $("engMenu").hidden = true;
  $("engBtn").setAttribute("aria-expanded", "false");
}
$("engBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  closeMenu();
  const open = $("engMenu").hidden;
  $("engMenu").hidden = !open;
  $("engBtn").setAttribute("aria-expanded", String(open));
  if (open) $("engMenu").querySelector("[aria-selected=true]")?.focus();
});

const ENG_KEY = "tablo.engines";

function readEngCache() {
  try {
    const c = JSON.parse(localStorage.getItem(ENG_KEY));
    if (c && Array.isArray(c.engines) && c.engines.length) return c;
  } catch {}
  return null;
}

async function initEngines() {
  let fresh = [];
  try { fresh = await browser.search.get(); } catch {}
  if (!fresh.length) return;

  const slim = fresh.map((e) => ({ name: e.name, isDefault: !!e.isDefault, favIconUrl: e.favIconUrl || null }));
  const changed = JSON.stringify(slim) !== JSON.stringify(engines);
  try { localStorage.setItem(ENG_KEY, JSON.stringify({ engines: slim })); } catch {}

  engines = slim;
  if (!engine || !engines.some((e) => e.name === engine)) {
    const def = engines.find((e) => e.isDefault) || engines[0];
    engine = def ? def.name : null;
  }
  if (changed) renderEngines();
}

$("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  const url = normalizeUrl(q);
  if (url) { location.href = url; return; }

  const args = { query: q, disposition: "CURRENT_TAB" };
  const def = engines.find((x) => x.isDefault);
  if (engine && (!def || def.name !== engine)) args.engine = engine;   // иначе — поисковик по умолчанию
  browser.search.search(args);
});

/* ---------- общие обработчики ---------- */
document.addEventListener("click", (e) => {
  if (!e.target.closest("#menu, #gear")) closeMenu();
  if (!e.target.closest("#engMenu, #engBtn")) closeEngMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("itemDlg").open || $("setDlg").open) return;
  if (!$("engMenu").hidden) { closeEngMenu(); $("engBtn").focus(); return; }
  if (!$("menu").hidden) { closeMenu(); $("gear").focus(); return; }
  if (openId) { navigate(null); return; }
  if (editing) setEditing(false);
});

/* ---------- старт ---------- */
// Всё нужное грузим параллельно и показываем страницу одним кадром:
// без чёрного экрана, без «доезжающих» плиток, обоев и иконки поисковика.
async function boot() {
  try {
    const cached = readEngCache();
    if (cached) {
      engines = cached.engines;
      const def = engines.find((e) => e.isDefault) || engines[0];
      engine = def ? def.name : null;
    }
    const engP = initEngines();
    const wallP = kv("readonly", (s) => s.get("wall")).then(applyWallpaper).catch(() => {});

    await Promise.all([load(), wallP, cached ? null : Promise.race([engP, delay(500)])]);

    applyDim();
    render();
    renderEngines();
    if (needsSave) save();

    const imgs = [...document.querySelectorAll("#tiles img, #engBtn img")];
    await Promise.race([Promise.all(imgs.map((i) => i.decode().catch(() => {}))), delay(300)]);
  } finally {
    document.documentElement.classList.remove("boot");
  }
  syncIcons();
}
boot();
