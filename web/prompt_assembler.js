import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

/*
 * ComfyUI Prompt Assembler - 前端面板
 *
 * 左边树（找）+ 右边组装区（顺序、启用/禁用、分组、临时修改）。
 * 分组是真正的容器（有自己的 children），组外也可以有顶层条目，
 * 所以可以在分组之间、以及末尾插入条目。
 *
 * 加入组装区：拖拽 或 点条目左侧的 ＋（点条目其余地方不会加入）。
 * 临时修改只影响组装区，不回写词库。
 * 不用 window.prompt（Electron 下不可用），全部自绘对话框。
 */

const NODE_NAME = "PromptAssembler";
const API_LIB = "/prompt_assembler/library";
const API_LIBS = "/prompt_assembler/libraries";
const API_CREATE = "/prompt_assembler/library/create";
const WIDGET_NAME = "assembled_prompt";

// ---------------------------------------------------------------------------
// 词库 IO（支持多份，按名字区分）
// ---------------------------------------------------------------------------

const libCache = new Map();

async function apiListLibraries() {
  const r = await api.fetchApi(API_LIBS, { cache: "no-store" });
  const j = r.ok ? await r.json() : { libraries: [] };
  return Array.isArray(j.libraries) && j.libraries.length ? j.libraries : ["library.yaml"];
}

async function apiGetLibrary(name = "library.yaml", force = false) {
  name = name || "library.yaml";
  if (!force && libCache.has(name)) return libCache.get(name);
  let data;
  try {
    const r = await api.fetchApi(API_LIB + "?name=" + encodeURIComponent(name), { cache: "no-store" });
    data = r.ok ? await r.json() : { separator: ", ", items: [] };
  } catch (e) {
    console.error("[PromptAssembler] 读取词库失败", e);
    data = { separator: ", ", items: [] };
  }
  if (!Array.isArray(data.items)) data.items = [];
  if (typeof data.separator !== "string") data.separator = ", ";
  libCache.set(name, data);
  return data;
}

async function apiSaveLibrary(name, lib) {
  name = name || "library.yaml";
  const r = await api.fetchApi(API_LIB + "?name=" + encodeURIComponent(name), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lib),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const saved = await r.json();
  libCache.set(name, saved);
  return saved;
}

async function apiCreateLibrary(name, from) {
  const r = await api.fetchApi(API_CREATE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, from }),
  });
  if (!r.ok) {
    let msg = "HTTP " + r.status;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return await r.json();
}

// ---------------------------------------------------------------------------
// 节点状态
// ---------------------------------------------------------------------------

function getWidget(node, name) {
  return node.widgets ? node.widgets.find((w) => w.name === name) : null;
}

// 旧版本用“扁平标记”表示分组（分组后面直到下一个分组都算它的）。
// 现在分组是容器，这里把旧数据迁移成嵌套结构。
function migrateFlatGroups(list) {
  const out = [];
  let cur = null;
  for (const n of list) {
    if (n && n.kind === "group") {
      cur = { kind: "group", title: n.title || "分组", collapsed: !!n.collapsed, children: [] };
      out.push(cur);
    } else if (cur) {
      cur.children.push(n);
    } else {
      out.push(n);
    }
  }
  return out;
}

function getAssembly(node) {
  if (!Array.isArray(node.properties.paAssembly)) node.properties.paAssembly = [];
  const list = node.properties.paAssembly;
  if (list.some((n) => n && n.kind === "group" && !Array.isArray(n.children))) {
    node.properties.paAssembly = migrateFlatGroups(list);
  }
  return node.properties.paAssembly;
}

function getSeparator(node, lib) {
  const v = node.properties.paSeparator;
  if (typeof v === "string") return v;
  return (lib && lib.separator) || ", ";
}

function getPresets(node) {
  if (!node.properties.paPresets || typeof node.properties.paPresets !== "object") {
    node.properties.paPresets = {};
  }
  return node.properties.paPresets;
}

function findLibItem(lib, path, label) {
  return (lib.items || []).find(
    (x) => x.path === path && String(x.label || "") === String(label || "")
  );
}

function resolveAssemblyItem(it, lib) {
  if (it.kind === "text") return it.text || "";
  if (typeof it.override === "string") return it.override; // 临时修改优先
  const f = findLibItem(lib, it.path, it.label);
  return f ? f.text || "" : it.text || "";
}

// 深度优先展开，分组本身不产出文本
function flattenLeaves(list, out) {
  for (const n of list || []) {
    if (n && n.kind === "group") flattenLeaves(n.children, out);
    else out.push(n);
  }
  return out;
}

function joinAssembly(node, lib) {
  const sep = getSeparator(node, lib);
  return flattenLeaves(getAssembly(node), [])
    .filter((it) => it.enabled !== false)
    .map((it) => resolveAssemblyItem(it, lib))
    .map((s) => (s == null ? "" : String(s)))
    .filter((s) => s.trim() !== "") // 只丢纯空白的项，保留原文（含首尾空白）
    .join(sep);
}

function syncNode(node, lib) {
  const w = getWidget(node, WIDGET_NAME);
  if (w) w.value = joinAssembly(node, lib);
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

// 分隔符框里用 \n / \t 表示换行、制表符，方便肉眼看见
function escapeSep(s) {
  return String(s || "").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}
function unescapeSep(s) {
  return String(s || "").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function nodeLibrary(node) {
  const v = node.properties.paLibrary;
  return typeof v === "string" && v ? v : "library.yaml";
}

function resync(node) {
  apiGetLibrary(nodeLibrary(node)).then((lib) => syncNode(node, lib));
}

// ---------------------------------------------------------------------------
// 词库树
// ---------------------------------------------------------------------------

function buildTree(items) {
  const root = { name: "", path: "", children: {}, items: [] };
  for (const it of items) {
    const parts = String(it.path || "")
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);
    let n = root;
    let acc = "";
    for (const p of parts) {
      acc = acc ? acc + "/" + p : p;
      if (!n.children[p]) n.children[p] = { name: p, path: acc, children: {}, items: [] };
      n = n.children[p];
    }
    n.items.push(it);
  }
  return root;
}

// ---------------------------------------------------------------------------
// CSS（只注入一次）
// ---------------------------------------------------------------------------

function injectStyle() {
  if (document.getElementById("pa-style")) return;
  const s = document.createElement("style");
  s.id = "pa-style";
  s.textContent = `
  .pa-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:12000;display:flex;align-items:center;justify-content:center;}
  .pa-modal{width:min(1100px,94vw);height:min(760px,92vh);background:#1b1b1f;color:#e6e6e6;border:1px solid #3a3a44;border-radius:12px;display:flex;flex-direction:column;font-size:13px;box-shadow:0 12px 48px rgba(0,0,0,.6);}
  .pa-head{display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid #3a3a44;flex-wrap:wrap;}
  .pa-title{font-weight:600;font-size:15px;margin-right:auto;}
  .pa-btn{background:#2c2c34;color:#e6e6e6;border:1px solid #45454f;border-radius:6px;padding:5px 12px;cursor:pointer;}
  .pa-btn:hover{background:#3a3a44;}
  .pa-btn.primary{background:#3b6ea5;border-color:#4d84c0;}
  .pa-btn.primary:hover{background:#4a80bb;}
  .pa-btn.danger{color:#ff9a9a;}
  .pa-input,.pa-textarea{background:#141418;color:#e6e6e6;border:1px solid #45454f;border-radius:6px;padding:5px 8px;font-family:inherit;font-size:13px;}
  .pa-input:focus,.pa-textarea:focus{outline:none;border-color:#5b8fc9;}
  .pa-body{display:flex;flex:1;min-height:0;}
  .pa-pane{display:flex;flex-direction:column;min-height:0;}
  .pa-left{width:46%;border-right:1px solid #3a3a44;}
  .pa-right{flex:1;}
  .pa-right.pa-dropactive{outline:2px dashed #5b8fc9;outline-offset:-4px;}
  .pa-panehead{padding:8px 12px;border-bottom:1px solid #2c2c34;color:#9aa0aa;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
  .pa-scroll{flex:1;overflow:auto;padding:8px 10px;}
  .pa-cat{margin:2px 0;}
  .pa-catname{cursor:pointer;padding:4px 6px;border-radius:5px;user-select:none;display:flex;align-items:center;gap:6px;color:#c8cdd6;}
  .pa-catname:hover{background:#26262e;}
  .pa-cattext{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .pa-catpen{opacity:0;color:#8fc7ff;padding:0 4px;border-radius:4px;}
  .pa-catname:hover .pa-catpen{opacity:1;}
  .pa-catpen:hover{background:#2e3a4a;}
  .pa-children{margin-left:14px;border-left:1px solid #2f2f38;padding-left:6px;}
  .pa-item{display:flex;gap:8px;align-items:flex-start;padding:5px 8px;border-radius:6px;border:1px solid transparent;}
  .pa-item:hover{background:#26262e;border-color:#3a3a44;}
  .pa-item .pa-ilabel{color:#8fc7ff;flex:0 0 auto;font-weight:600;}
  .pa-item .pa-itext{color:#aab0ba;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;}
  .pa-item .pa-add{color:#6cc07a;flex:0 0 auto;font-weight:700;padding:0 5px;border-radius:4px;cursor:pointer;}
  .pa-item .pa-add:hover{background:#2e4a34;color:#a6e0b0;}
  .pa-item .pa-del{color:#777;flex:0 0 auto;cursor:pointer;padding:0 3px;}
  .pa-item .pa-del:hover{color:#ff8080;}
  .pa-row{display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px solid #33333c;border-radius:6px;margin-bottom:6px;background:#202027;position:relative;}
  .pa-row.dragging{opacity:.4;}
  .pa-row.drop-before::before,.pa-row.drop-after::after{content:"";position:absolute;left:0;right:0;height:3px;background:#5b8fc9;border-radius:2px;box-shadow:0 0 6px #5b8fc9;}
  .pa-row.drop-before::before{top:-4px;}
  .pa-row.drop-after::after{bottom:-4px;}
  .pa-row.disabled .pa-rtext,.pa-row.disabled .pa-rlabel{opacity:.4;text-decoration:line-through;}
  .pa-row.overridden{background:#2b2620;border-color:#5c4a28;}
  .pa-row.overridden .pa-rtext{color:#ffcf7a;}
  .pa-handle{cursor:grab;color:#666;user-select:none;}
  .pa-rlabel{color:#8fc7ff;font-weight:600;flex:0 0 auto;}
  .pa-rlabel.pa-aliased{color:#ffd479;}
  .pa-rtext{color:#c3c8d2;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;}
  .pa-badge{font-size:11px;color:#888;border:1px solid #444;border-radius:4px;padding:0 4px;white-space:nowrap;}
  .pa-badge.pa-editable{cursor:pointer;}
  .pa-badge.pa-editable:hover{color:#fff;border-color:#777;}
  .pa-badge.pa-editable.on{color:#ffcf7a;border-color:#7a5a2a;}
  .pa-grouphdr{background:#2b3140;border-color:#3f4a5e;}
  .pa-grouptitle{color:#ffd479;font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;}
  .pa-arrow{cursor:pointer;color:#aab2bd;user-select:none;width:12px;text-align:center;}
  .pa-arrow:hover{color:#fff;}
  .pa-groupkids{position:relative;transition:background .1s;border-radius:6px;}
  .pa-groupkids.drop-into{background:rgba(91,143,201,.14);outline:1px dashed #5b8fc9;outline-offset:-2px;}
  .pa-kidempty{padding:6px 8px;border:1px dashed #3a3a44;border-radius:6px;color:#6f757f;font-size:12px;margin-bottom:6px;}
  .pa-foot{padding:10px 16px;border-top:1px solid #3a3a44;display:flex;gap:10px;align-items:center;}
  .pa-muted{color:#7d838d;}
  .pa-additem{border:1px dashed #45454f;border-radius:6px;padding:8px;margin-top:8px;display:flex;flex-direction:column;gap:6px;}
  .pa-inline{display:flex;gap:6px;align-items:center;}
  .pa-icon{cursor:pointer;color:#888;}
  .pa-icon:hover{color:#ff8080;}
  .pa-dialog-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:13500;display:flex;align-items:center;justify-content:center;}
  .pa-dialog{background:#1f1f26;border:1px solid #45454f;border-radius:10px;padding:16px;width:min(460px,90vw);display:flex;flex-direction:column;gap:10px;box-shadow:0 10px 40px rgba(0,0,0,.6);}
  .pa-dialog-msg{color:#e6e6e6;white-space:pre-wrap;}
  .pa-dialog-btns{display:flex;gap:8px;justify-content:flex-end;}
  `;
  document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// 自绘对话框（Electron 下没有 window.prompt）
// ---------------------------------------------------------------------------

function paConfirm(message) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "pa-dialog-ov";
    const box = document.createElement("div");
    box.className = "pa-dialog";
    const msg = document.createElement("div");
    msg.className = "pa-dialog-msg";
    msg.textContent = message;
    const btns = document.createElement("div");
    btns.className = "pa-dialog-btns";
    const ok = document.createElement("button");
    ok.className = "pa-btn primary";
    ok.textContent = "确定";
    const cancel = document.createElement("button");
    cancel.className = "pa-btn";
    cancel.textContent = "取消";
    btns.append(ok, cancel);
    box.append(msg, btns);
    ov.appendChild(box);
    document.body.appendChild(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) done(false); });
    setTimeout(() => ok.focus(), 0);
  });
}

function paAskText(message, defaultValue = "") {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "pa-dialog-ov";
    const box = document.createElement("div");
    box.className = "pa-dialog";
    const msg = document.createElement("div");
    msg.className = "pa-dialog-msg";
    msg.textContent = message;
    const inp = document.createElement("textarea");
    inp.className = "pa-textarea";
    inp.rows = 3;
    inp.value = defaultValue || "";
    const btns = document.createElement("div");
    btns.className = "pa-dialog-btns";
    const ok = document.createElement("button");
    ok.className = "pa-btn primary";
    ok.textContent = "确定";
    const cancel = document.createElement("button");
    cancel.className = "pa-btn";
    cancel.textContent = "取消";
    btns.append(ok, cancel);
    box.append(msg, inp, btns);
    ov.appendChild(box);
    document.body.appendChild(ov);
    const done = (v) => {
      ov.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    ok.onclick = () => done(inp.value);
    cancel.onclick = () => done(null);
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(null); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.stopPropagation(); done(inp.value); }
    };
    document.addEventListener("keydown", onKey, true);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) done(null); });
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  });
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

let openModalEl = null;

async function openPanel(node) {
  if (openModalEl && openModalEl.isConnected) return; // 已经开着就不重复开
  openModalEl = null;
  injectStyle();
  let libName = nodeLibrary(node);
  let lib = await apiGetLibrary(libName, true);
  let dirty = false;
  let treeDragItem = null; // 从词库树里拖出来的条目
  let dragState = null;    // 组装区内正在拖动的 {list, index, item}
  const treeOpen = new Map(); // 词库树各分区的展开状态（path -> bool）

  const overlay = document.createElement("div");
  overlay.className = "pa-overlay";

  const modal = document.createElement("div");
  modal.className = "pa-modal";
  overlay.appendChild(modal);

  // ---- head ----
  const head = document.createElement("div");
  head.className = "pa-head";
  head.innerHTML = `<div class="pa-title">提示词组装器</div>`;

  const libLabel = document.createElement("span");
  libLabel.className = "pa-muted";
  libLabel.textContent = "词库";
  head.appendChild(libLabel);
  const libSel = document.createElement("select");
  libSel.className = "pa-input";
  libSel.title = "选择词库（跟着当前节点/工作流走，不影响其他工程）";
  libSel.addEventListener("change", () => switchLibrary(libSel.value));
  head.appendChild(libSel);
  head.appendChild(mkBtn("新建词库", () => createLibrary()));

  const search = document.createElement("input");
  search.className = "pa-input";
  search.placeholder = "搜索条目标签/文本/路径…";
  search.style.width = "220px";
  head.appendChild(search);

  const sepLabel = document.createElement("span");
  sepLabel.className = "pa-muted";
  sepLabel.textContent = "分隔符";
  head.appendChild(sepLabel);
  const sepInput = document.createElement("input");
  sepInput.className = "pa-input";
  sepInput.style.width = "70px";
  sepInput.title = "分隔符；\\n 表示换行，\\t 表示制表符";
  sepInput.value = escapeSep(getSeparator(node, lib));
  sepInput.addEventListener("input", () => {
    node.properties.paSeparator = unescapeSep(sepInput.value);
    syncNode(node, lib);
  });
  head.appendChild(sepInput);

  head.appendChild(mkBtn("刷新词库", async () => {
    const l = await apiGetLibrary(libName, true);
    lib.items = l.items;
    lib.separator = l.separator;
    renderTree();
    renderAssembly();
  }));

  head.appendChild(mkBtn("保存词库到文件", async () => {
    try {
      const saved = await apiSaveLibrary(libName, lib);
      lib.items = saved.items;
      lib.separator = saved.separator;
      dirty = false;
      renderTree();
      toast("词库已保存");
    } catch (e) {
      toast("保存失败: " + e.message, true);
    }
  }));

  head.appendChild(mkBtn("关闭", () => close()));
  modal.appendChild(head);

  // ---- body ----
  const body = document.createElement("div");
  body.className = "pa-body";

  const left = document.createElement("div");
  left.className = "pa-pane pa-left";
  const leftHead = document.createElement("div");
  leftHead.className = "pa-panehead";
  leftHead.innerHTML = `<span>词库（点 ＋ 或拖到右边加入组装区）</span>`;
  const leftScroll = document.createElement("div");
  leftScroll.className = "pa-scroll";
  const addForm = document.createElement("div");
  addForm.className = "pa-additem";
  addForm.innerHTML = `
    <div class="pa-muted">新增条目（路径用 / 分层，例如 角色/紫罗兰/常服1/上身服设）</div>
    <input class="pa-input pa-new-path" placeholder="路径" list="pa-path-list">
    <input class="pa-input pa-new-label" placeholder="短名（可空）">
    <textarea class="pa-textarea pa-new-text" rows="2" placeholder="提示词文本（原样输出，不加权重）"></textarea>
    <div><button class="pa-btn pa-new-add">加入词库</button></div>
    <datalist id="pa-path-list"></datalist>
  `;
  left.appendChild(leftHead);
  left.appendChild(leftScroll);
  left.appendChild(addForm);
  body.appendChild(left);

  const right = document.createElement("div");
  right.className = "pa-pane pa-right";
  const rightHead = document.createElement("div");
  rightHead.className = "pa-panehead";
  const presetSel = document.createElement("select");
  presetSel.className = "pa-input";
  rightHead.appendChild(document.createTextNode("预设"));
  rightHead.appendChild(presetSel);
  rightHead.appendChild(mkBtn("载入", () => loadPreset()));
  rightHead.appendChild(mkBtn("保存当前", () => savePreset()));
  rightHead.appendChild(mkBtn("删除", () => delPreset(), "danger"));
  rightHead.appendChild(mkBtn("＋分组", () => {
    getAssembly(node).push({ kind: "group", title: "新分组", collapsed: false, children: [] });
    renderAssembly();
  }));
  rightHead.appendChild(mkBtn("清空", () => {
    node.properties.paAssembly = [];
    renderAssembly();
    syncNode(node, lib);
  }, "danger"));
  const rightScroll = document.createElement("div");
  rightScroll.className = "pa-scroll";
  const fixedForm = document.createElement("div");
  fixedForm.className = "pa-additem";
  fixedForm.innerHTML = `
    <div class="pa-muted">临时/固定文本（插到组装区末尾，可拖动调位置）</div>
    <div class="pa-inline">
      <input class="pa-input pa-fixed-input" placeholder="例如 Picture 1: 或 某段临时描述" style="flex:1">
      <button class="pa-btn pa-fixed-add">插入</button>
    </div>
  `;
  right.appendChild(rightHead);
  right.appendChild(rightScroll);
  right.appendChild(fixedForm);
  body.appendChild(right);

  modal.appendChild(body);

  // ---- foot ----
  const foot = document.createElement("div");
  foot.className = "pa-foot";
  const preview = document.createElement("div");
  preview.className = "pa-muted";
  preview.style.flex = "1";
  preview.style.overflow = "hidden";
  preview.style.textOverflow = "ellipsis";
  preview.style.whiteSpace = "nowrap";
  foot.appendChild(preview);
  foot.appendChild(mkBtn("应用到节点", async () => {
    syncNode(node, lib);
    await close();
  }, "primary"));
  modal.appendChild(foot);

  document.body.appendChild(overlay);
  openModalEl = overlay;

  // ---- 通用 ----
  function mkBtn(text, cb, cls) {
    const b = document.createElement("button");
    b.className = "pa-btn" + (cls ? " " + cls : "");
    b.textContent = text;
    b.addEventListener("click", cb);
    return b;
  }

  async function close() {
    if (dirty && !(await paConfirm("词库有未保存的改动，仍要关闭吗？"))) return;
    document.removeEventListener("keydown", onPanelKey);
    overlay.remove();
    openModalEl = null;
  }

  const onPanelKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onPanelKey);

  function updatePreview() {
    const s = joinAssembly(node, lib);
    preview.textContent = s ? "→ " + s : "（组装区为空）";
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function toast(msg, isErr) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = `position:fixed;bottom:38px;left:50%;transform:translateX(-50%);background:${isErr ? "#7a2626" : "#26406a"};color:#fff;padding:8px 16px;border-radius:8px;z-index:14000;font-size:13px;`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  async function refreshLibraryOptions(selected) {
    let names = [];
    try { names = await apiListLibraries(); } catch (_) {}
    if (!Array.isArray(names) || !names.length) names = [libName];
    if (!names.includes(libName)) names.unshift(libName);
    libSel.innerHTML = "";
    for (const n of names) {
      const o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      libSel.appendChild(o);
    }
    libSel.value = selected || libName;
  }

  async function switchLibrary(name) {
    if (!name) return;
    libName = name;
    node.properties.paLibrary = name;
    const l = await apiGetLibrary(name, true);
    lib.items = l.items;
    lib.separator = l.separator;
    dirty = false;
    if (typeof node.properties.paSeparator !== "string") sepInput.value = escapeSep(getSeparator(node, lib));
    renderTree();
    renderAssembly();
    syncNode(node, lib);
  }

  async function createLibrary() {
    const name = await paAskText("新词库文件名（以 .yaml 结尾）", "library-新项目.yaml");
    if (!name) return;
    try {
      await apiCreateLibrary(name, libName);
      await refreshLibraryOptions(name);
      await switchLibrary(name);
      toast("已创建并切换到 " + name);
    } catch (e) {
      toast("创建失败: " + e.message, true);
    }
  }

  function makeLibEntry(item) {
    return {
      kind: "lib",
      path: item.path,
      label: item.label || "",
      text: item.text || "",
      enabled: true,
    };
  }

  // 找到路径匹配的（最深的）分组
  function findGroupForPath(list, path) {
    let hit = null;
    for (const n of list) {
      if (n && n.kind === "group") {
        if (n.title && (path === n.title || path.startsWith(n.title + "/"))) hit = n;
        const deeper = findGroupForPath(n.children || [], path);
        if (deeper) hit = deeper;
      }
    }
    return hit;
  }

  // 改了词库条目的短名后，同步组装区/预设里对它的引用，保持链接不断
  function retargetLabelInList(list, path, oldLabel, newLabel) {
    for (const n of list || []) {
      if (!n) continue;
      if (n.kind === "group") {
        retargetLabelInList(n.children, path, oldLabel, newLabel);
        continue;
      }
      if (n.kind === "lib" && n.path === path && String(n.label || "") === oldLabel) {
        n.label = newLabel;
      }
    }
  }

  function retargetLabelRefs(path, oldLabel, newLabel) {
    retargetLabelInList(getAssembly(node), path, oldLabel, newLabel);
    const presets = getPresets(node);
    for (const k of Object.keys(presets)) {
      if (Array.isArray(presets[k])) retargetLabelInList(presets[k], path, oldLabel, newLabel);
    }
  }

  // 重命名目录 = 改路径前缀，并同步组装区/预设里的 path 引用
  function retargetPathInList(list, oldPrefix, newPrefix) {
    for (const n of list || []) {
      if (!n) continue;
      if (n.kind === "group") { retargetPathInList(n.children, oldPrefix, newPrefix); continue; }
      if (n.kind === "lib" && n.path) {
        if (n.path === oldPrefix) n.path = newPrefix;
        else if (n.path.startsWith(oldPrefix + "/")) n.path = newPrefix + n.path.slice(oldPrefix.length);
      }
    }
  }

  async function renameDir(oldPath, currentName) {
    const v = await paAskText(`重命名目录（${oldPath}）`, currentName);
    if (v == null) return;
    const name = v.split("/").map((s) => s.trim()).filter(Boolean).join("/");
    if (!name || name === currentName) return;
    const slash = oldPath.lastIndexOf("/");
    const parent = slash >= 0 ? oldPath.slice(0, slash) : "";
    const newPrefix = parent ? parent + "/" + name : name;
    if (newPrefix === oldPath) return;
    let changed = false;
    for (const it of lib.items) {
      if (it.path === oldPath) { it.path = newPrefix; changed = true; }
      else if (it.path.startsWith(oldPath + "/")) {
        it.path = newPrefix + it.path.slice(oldPath.length);
        changed = true;
      }
    }
    if (!changed) return;
    retargetPathInList(getAssembly(node), oldPath, newPrefix);
    const presets = getPresets(node);
    for (const k of Object.keys(presets)) {
      if (Array.isArray(presets[k])) retargetPathInList(presets[k], oldPath, newPrefix);
    }
    dirty = true;
    renderTree();
    renderAssembly();
    syncNode(node, lib);
    toast("已重命名目录（记得点“保存词库到文件”）");
  }

  // ＋ 按钮：自动归组，追加到末尾
  function addToAssembly(item) {
    const entry = makeLibEntry(item);
    const g = findGroupForPath(getAssembly(node), item.path);
    if (g) {
      g.collapsed = false;
      (g.children = g.children || []).push(entry);
    } else {
      getAssembly(node).push(entry);
    }
    renderAssembly();
    syncNode(node, lib);
  }

  // ---- 词库树 ----
  function renderTree() {
    leftScroll.innerHTML = "";
    const root = buildTree(lib.items);
    const kw = search.value.trim().toLowerCase();

    const dl = left.querySelector("#pa-path-list");
    if (dl) {
      dl.innerHTML = "";
      for (const p of new Set(lib.items.map((i) => i.path))) {
        const o = document.createElement("option");
        o.value = p;
        dl.appendChild(o);
      }
    }

    function matches(it) {
      if (!kw) return true;
      return (
        (it.path || "").toLowerCase().includes(kw) ||
        (it.label || "").toLowerCase().includes(kw) ||
        (it.text || "").toLowerCase().includes(kw)
      );
    }

    function renderItem(it) {
      const row = document.createElement("div");
      row.className = "pa-item";
      row.draggable = true;
      row.title = (it.path || "") + "（拖到右侧组装区，或点左侧 ＋；双击文本可直接改）";
      row.innerHTML = `
        <span class="pa-add" title="加入组装区">＋</span>
        <span class="pa-ilabel">${escapeHtml(it.label || "")}</span>
        <span class="pa-itext">${escapeHtml(it.text || "")}</span>
        <span class="pa-del" title="从词库删除">✕</span>
      `;
      row.querySelector(".pa-add").addEventListener("click", (e) => {
        e.stopPropagation();
        addToAssembly(it);
      });
      row.querySelector(".pa-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!(await paConfirm(`从词库删除：${it.label || it.text} ？`))) return;
        const idx = lib.items.indexOf(it);
        if (idx >= 0) lib.items.splice(idx, 1);
        dirty = true;
        renderTree();
        renderAssembly();
        syncNode(node, lib);
      });
      row.querySelector(".pa-itext").addEventListener("dblclick", async (e) => {
        e.stopPropagation();
        const v = await paAskText(`修改文本（${it.path}）`, it.text || "");
        if (v === null) return;
        it.text = v;
        dirty = true;
        renderTree();
        renderAssembly();
        syncNode(node, lib);
        toast("已修改（记得点“保存词库到文件”）");
      });
      row.querySelector(".pa-ilabel").addEventListener("dblclick", async (e) => {
        e.stopPropagation();
        const oldLabel = it.label || "";
        const v = await paAskText(`修改短名（${it.path}）`, oldLabel);
        if (v === null || v === oldLabel) return;
        it.label = v;
        retargetLabelRefs(it.path, oldLabel, v);
        dirty = true;
        renderTree();
        renderAssembly();
        syncNode(node, lib);
        toast("已修改短名（记得点“保存词库到文件”）");
      });
      row.addEventListener("dragstart", (e) => {
        treeDragItem = it;
        e.dataTransfer.effectAllowed = "copy";
        try { e.dataTransfer.setData("text/plain", it.path || ""); } catch (_) {}
        right.classList.add("pa-dropactive");
      });
      row.addEventListener("dragend", () => {
        treeDragItem = null;
        right.classList.remove("pa-dropactive");
      });
      return row;
    }

    function subtreeHasMatch(n) {
      for (const it of n.items) if (matches(it)) return true;
      for (const k of Object.keys(n.children)) {
        if (subtreeHasMatch(n.children[k])) return true;
      }
      return false;
    }

    function renderNode(n, container) {
      const keys = Object.keys(n.children).sort((a, b) => a.localeCompare(b, "zh"));
      for (const k of keys) {
        const child = n.children[k];
        if (!subtreeHasMatch(child)) continue; // 搜索时跳过没命中的目录
        const wrap = document.createElement("div");
        wrap.className = "pa-cat";
        const nameEl = document.createElement("div");
        nameEl.className = "pa-catname";
        nameEl.innerHTML = `<span class="pa-arrow">▾</span><span class="pa-cattext">${escapeHtml(child.name)}</span><span class="pa-catpen" title="重命名此目录">✎</span>`;
        const kids = document.createElement("div");
        kids.className = "pa-children";
        let open = treeOpen.has(child.path) ? treeOpen.get(child.path) : true;
        kids.style.display = open ? "" : "none";
        nameEl.firstChild.textContent = open ? "▾" : "▸";
        nameEl.addEventListener("click", () => {
          open = !open;
          treeOpen.set(child.path, open);
          kids.style.display = open ? "" : "none";
          nameEl.firstChild.textContent = open ? "▾" : "▸";
        });
        nameEl.querySelector(".pa-catpen").addEventListener("click", (e) => {
          e.stopPropagation();
          renameDir(child.path, child.name);
        });
        renderNode(child, kids);
        wrap.appendChild(nameEl);
        wrap.appendChild(kids);
        container.appendChild(wrap);
        if (kw) {
          // 搜索时临时展开，不改动保存的状态
          kids.style.display = "";
          nameEl.firstChild.textContent = "▾";
        }
      }
      for (const it of n.items) {
        if (!matches(it)) continue;
        container.appendChild(renderItem(it));
      }
    }

    renderNode(root, leftScroll);
    if (!leftScroll.children.length) {
      leftScroll.innerHTML = `<div class="pa-muted">没有匹配的条目</div>`;
    }
  }

  search.addEventListener("input", renderTree);

  addForm.querySelector(".pa-new-add").addEventListener("click", () => {
    const path = addForm.querySelector(".pa-new-path").value.trim();
    const label = addForm.querySelector(".pa-new-label").value.trim();
    const text = addForm.querySelector(".pa-new-text").value.trim();
    if (!path || !text) {
      toast("路径和文本不能为空", true);
      return;
    }
    lib.items.push({ path, label, text });
    dirty = true;
    addForm.querySelector(".pa-new-text").value = "";
    renderTree();
    toast("已加入词库（记得点“保存词库到文件”）");
  });

  // ---- 组装区 ----
  // 分组是容器：{kind:"group", title, collapsed, children:[...]}。
  // 组外也能有顶层条目，所以可以在分组之间、以及末尾插入。
  function countLeaves(list) {
    let n = 0;
    for (const x of list || []) n += x.kind === "group" ? countLeaves(x.children || []) : 1;
    return n;
  }

  function containsList(group, list) {
    if (group.children === list) return true;
    for (const c of group.children || []) {
      if (c.kind === "group" && containsList(c, list)) return true;
    }
    return false;
  }

  async function editRow(it) {
    if (it.kind === "text") {
      const v = await paAskText("编辑文本", it.text || "");
      if (v !== null) { it.text = v; renderAssembly(); syncNode(node, lib); }
    } else {
      const cur = typeof it.override === "string" ? it.override : resolveAssemblyItem(it, lib);
      const v = await paAskText("临时修改（只改变组装区内文本，不会写回词库）", cur);
      if (v !== null) { it.override = v; renderAssembly(); syncNode(node, lib); }
    }
  }

  // 放下：内部拖动 或 从词库树拖入，都落到 tlist 的 tindex 位置
  function dropInto(tlist, tindex) {
    if (dragState) {
      const st = dragState;
      if (st.item.kind === "group" && containsList(st.item, tlist)) return; // 不能进自己子树
      let ti = tindex;
      if (st.list === tlist && st.index < tindex) ti = tindex - 1;
      st.list.splice(st.index, 1);
      ti = Math.max(0, Math.min(ti, tlist.length));
      tlist.splice(ti, 0, st.item);
      dragState = null;
      renderAssembly();
      syncNode(node, lib);
    } else if (treeDragItem) {
      const it = treeDragItem;
      treeDragItem = null;
      right.classList.remove("pa-dropactive");
      const k = Math.max(0, Math.min(tindex, tlist.length));
      tlist.splice(k, 0, makeLibEntry(it));
      renderAssembly();
      syncNode(node, lib);
    }
  }

  function attachDrag(row, item, list, index) {
    row.addEventListener("dragstart", (e) => {
      dragState = { list, index, item };
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", String(index)); } catch (_) {}
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      dragState = null;
      document.querySelectorAll(".pa-row").forEach((n) => n.classList.remove("drop-before", "drop-after"));
      document.querySelectorAll(".pa-groupkids").forEach((n) => n.classList.remove("drop-into"));
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      row.classList.toggle("drop-before", before);
      row.classList.toggle("drop-after", !before);
      row.dataset.insertAt = String(before ? index : index + 1);
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const k = row.dataset.insertAt != null ? parseInt(row.dataset.insertAt, 10) : index;
      row.classList.remove("drop-before", "drop-after");
      dropInto(list, k);
    });
  }

  function makeItemRow(it, list, i, depth) {
    const row = document.createElement("div");
    row.className = "pa-row" + (it.enabled === false ? " disabled" : "");
    row.draggable = true;
    row.style.marginLeft = depth * 16 + "px";

    const handle = document.createElement("span");
    handle.className = "pa-handle";
    handle.textContent = "⠿";
    row.appendChild(handle);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = it.enabled !== false;
    cb.title = "启用/禁用";
    cb.addEventListener("change", () => {
      it.enabled = cb.checked;
      row.classList.toggle("disabled", !cb.checked);
      syncNode(node, lib);
      updatePreview();
    });
    row.appendChild(cb);

    const baseLabel = it.kind === "text" ? "[文本]" : (it.label || it.path);
    const label = document.createElement("span");
    label.className = "pa-rlabel" + (it.alias ? " pa-aliased" : "");
    label.textContent = it.alias || baseLabel;
    label.title = it.alias
      ? `临时显示名；原名：${baseLabel}（双击改；留空则恢复原名）`
      : "双击临时改名（只改组装区显示名，不动词库）";
    label.addEventListener("dblclick", async (e) => {
      e.stopPropagation();
      const v = await paAskText("临时改名（只改组装区显示名，不动词库）", it.alias || "");
      if (v === null) return;
      if (v.trim() === "") delete it.alias; // 留空 = 恢复原名
      else it.alias = v.trim();
      renderAssembly();
    });
    row.appendChild(label);

    const text = document.createElement("span");
    text.className = "pa-rtext";
    text.textContent = resolveAssemblyItem(it, lib);
    text.title = it.kind === "text" ? "双击编辑" : "双击临时修改（不回写词库）";
    text.addEventListener("dblclick", (e) => { e.stopPropagation(); editRow(it); });
    row.appendChild(text);

    if (it.kind === "text") {
      const badge = document.createElement("span");
      badge.className = "pa-badge pa-editable";
      badge.textContent = "编辑";
      badge.title = "编辑这段文本";
      badge.addEventListener("click", (e) => { e.stopPropagation(); editRow(it); });
      row.appendChild(badge);
    } else {
      const overridden = typeof it.override === "string";
      if (overridden) row.classList.add("overridden");
      const badge = document.createElement("span");
      badge.className = "pa-badge pa-editable" + (overridden ? " on" : "");
      badge.textContent = overridden ? "已改 ↺" : "临时修改";
      badge.title = overridden ? "已临时修改，点此还原为词库原文" : "临时修改（不回写词库）";
      badge.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (overridden) {
          if (!(await paConfirm("还原为词库原文？"))) return;
          delete it.override;
          renderAssembly();
          syncNode(node, lib);
        } else {
          editRow(it);
        }
      });
      row.appendChild(badge);
    }

    const del = document.createElement("span");
    del.className = "pa-icon";
    del.textContent = "✕";
    del.title = "从组装区移除";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      list.splice(i, 1);
      renderAssembly();
      syncNode(node, lib);
    });
    row.appendChild(del);

    attachDrag(row, it, list, i);
    return row;
  }

  function makeGroupRow(g, list, i, depth) {
    const row = document.createElement("div");
    row.className = "pa-row pa-grouphdr";
    row.draggable = true;
    row.style.marginLeft = depth * 16 + "px";

    const handle = document.createElement("span");
    handle.className = "pa-handle";
    handle.textContent = "⠿";
    row.appendChild(handle);

    const arrow = document.createElement("span");
    arrow.className = "pa-arrow";
    arrow.textContent = g.collapsed ? "▸" : "▾";
    arrow.title = "展开/收起";
    arrow.addEventListener("click", (e) => { e.stopPropagation(); g.collapsed = !g.collapsed; renderAssembly(); });
    row.appendChild(arrow);

    const title = document.createElement("span");
    title.className = "pa-grouptitle";
    title.textContent = g.title || "分组";
    title.title = "双击重命名";
    title.addEventListener("dblclick", async (e) => {
      e.stopPropagation();
      const v = await paAskText("分组名称", g.title || "");
      if (v !== null) { g.title = v; renderAssembly(); }
    });
    row.appendChild(title);

    const cnt = document.createElement("span");
    cnt.className = "pa-badge";
    cnt.textContent = countLeaves(g.children || []) + " 条";
    row.appendChild(cnt);

    const del = document.createElement("span");
    del.className = "pa-icon";
    del.textContent = "✕";
    del.title = "解散分组（成员提到上一层，保留）";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = list.indexOf(g);
      if (idx >= 0) list.splice(idx, 1, ...(g.children || []));
      renderAssembly();
      syncNode(node, lib);
    });
    row.appendChild(del);

    attachDrag(row, g, list, i);
    return row;
  }

  function renderInto(container, list, depth) {
    list.forEach((n, i) => {
      if (n && n.kind === "group") {
        container.appendChild(makeGroupRow(n, list, i, depth));
        const kids = document.createElement("div");
        kids.className = "pa-groupkids";
        kids.style.marginLeft = (depth + 1) * 16 + "px";
        if (n.collapsed) kids.style.display = "none";
        kids.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.stopPropagation();
          kids.classList.add("drop-into");
        });
        kids.addEventListener("dragleave", (e) => {
          if (e.target === kids) kids.classList.remove("drop-into");
        });
        kids.addEventListener("drop", (e) => {
          e.preventDefault();
          e.stopPropagation();
          kids.classList.remove("drop-into");
          if (e.target.closest(".pa-row")) return; // 行自己处理
          n.children = n.children || [];
          dropInto(n.children, n.children.length);
        });
        renderInto(kids, n.children || [], depth + 1);
        if (!(n.children || []).length) {
          const ph = document.createElement("div");
          ph.className = "pa-kidempty";
          ph.textContent = "（空分组，拖条目到这里）";
          kids.appendChild(ph);
        }
        container.appendChild(kids);
      } else {
        container.appendChild(makeItemRow(n, list, i, depth));
      }
    });
  }

  function renderAssembly() {
    rightScroll.innerHTML = "";
    const list = getAssembly(node);
    if (!list.length) {
      rightScroll.innerHTML = `<div class="pa-muted">组装区为空：点左侧 ＋ 或从左边拖条目进来，也可插入固定文本。点“＋分组”建一个分组容器。</div>`;
      updatePreview();
      renderPresetOptions();
      return;
    }
    renderInto(rightScroll, list, 0);
    updatePreview();
    renderPresetOptions();
  }

  // 拖到右侧空白处 = 追加到顶层末尾
  right.addEventListener("dragover", (e) => {
    if (treeDragItem || dragState) e.preventDefault();
  });
  right.addEventListener("drop", (e) => {
    if (!treeDragItem && !dragState) return;
    if (e.target.closest && e.target.closest(".pa-row")) return;
    e.preventDefault();
    dropInto(getAssembly(node), getAssembly(node).length);
  });
  rightScroll.addEventListener("dragover", (e) => e.preventDefault());
  rightScroll.addEventListener("drop", (e) => {
    if (e.target !== rightScroll) return;
    if (!treeDragItem && !dragState) return;
    e.preventDefault();
    const list = getAssembly(node);
    dropInto(list, list.length);
  });

  // 固定文本
  fixedForm.querySelector(".pa-fixed-add").addEventListener("click", () => {
    const inp = fixedForm.querySelector(".pa-fixed-input");
    const v = inp.value.trim();
    if (!v) return;
    getAssembly(node).push({ kind: "text", text: v, label: "文本", enabled: true });
    inp.value = "";
    renderAssembly();
    syncNode(node, lib);
  });

  // ---- 预设 ----
  function renderPresetOptions() {
    const presets = getPresets(node);
    const cur = presetSel.value;
    presetSel.innerHTML = `<option value="">（预设）</option>`;
    for (const name of Object.keys(presets)) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      presetSel.appendChild(o);
    }
    if (presets[cur]) presetSel.value = cur;
  }
  async function savePreset() {
    const name = await paAskText("预设名称", presetSel.value || "");
    if (!name) return;
    getPresets(node)[name] = JSON.parse(JSON.stringify(getAssembly(node)));
    renderPresetOptions();
    presetSel.value = name;
    toast("预设已保存到当前节点");
  }
  function loadPreset() {
    const name = presetSel.value;
    if (!name) return;
    const p = getPresets(node)[name];
    if (!p) return;
    node.properties.paAssembly = JSON.parse(JSON.stringify(p));
    renderAssembly();
    syncNode(node, lib);
  }
  async function delPreset() {
    const name = presetSel.value;
    if (!name) return;
    if (!(await paConfirm(`删除预设 ${name}？`))) return;
    delete getPresets(node)[name];
    renderPresetOptions();
  }

  // ---- init ----
  refreshLibraryOptions(libName);
  renderTree();
  renderAssembly();
  syncNode(node, lib); // 打开面板时同步节点输出（例如旧数据迁移后）
  setTimeout(() => search.focus(), 0);
}

// ---------------------------------------------------------------------------
// 注册扩展
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "PromptAssembler.Panel",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const node = this;
      node.addWidget("button", "打开组装面板", null, () => openPanel(node));
      setTimeout(() => resync(node), 80);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      const node = this;
      setTimeout(() => resync(node), 80);
      return r;
    };
  },
  async loadedGraphNode(node) {
    if (node.type === NODE_NAME) resync(node);
  },
});

console.log("[PromptAssembler] 前端扩展已加载");
