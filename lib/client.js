/**
 * dsh-dream-memory — Client UI（纯 DOM，无 React 依赖）
 *
 * 功能：
 *   1. 侧边栏入口按钮（徽标显示记忆条数）
 *   2. 点击打开中心面板：显示库状态 + 9 项个性化设置 + 保存按钮
 *   3. 保存后立即生效（宿主端从 settings.json 动态读取）
 */

window.__ModuleLoader__.load({
  id: "dsh-dream-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── 样式 ──
    const CSS = `
[data-dm-view]{z-index:5;display:none;position:absolute;inset:0}
html[data-dm-active] [data-dm-view]{display:block}
html[data-dm-active] [data-pane=conversation]>:not([data-dm-view]){display:none}
._dm_entry{width:100%;height:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:0 12px;font-size:13px;display:flex}
._dm_entry:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary)}
._dm_entry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary);font-weight:600}
._dm_entryLabel{text-overflow:ellipsis;overflow:hidden}
._dm_entryBadge{flex:none;margin-left:auto;font-size:11px;line-height:1;padding:3px 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
[data-dsh-frame][data-sidebar-collapsed] ._dm_entry{justify-content:center;width:100%;padding:0}
[data-dsh-frame][data-sidebar-collapsed] ._dm_entryLabel,[data-dsh-frame][data-sidebar-collapsed] ._dm_entryBadge{display:none}
._dm_view{overflow:hidden}
._dm_panel{background:var(--dsw-alias-bg-base);min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);flex-direction:column;gap:10px;padding:14px 16px 16px;display:flex}
._dm_header{flex:none;align-items:center;gap:10px;display:flex}
._dm_title{color:var(--dsw-alias-label-primary);white-space:nowrap;flex:1;margin:0;font-size:16px;font-weight:700}
._dm_close{font:inherit;cursor:pointer;background:0 0;border:none;border-radius:6px;width:26px;height:26px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
._dm_close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
._dm_body{flex:1;min-height:0;overflow:auto;flex-direction:column;gap:12px;display:flex}
._dm_stats{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px;display:flex;flex-wrap:wrap;gap:8px}
._dm_stat{flex:1;min-width:100px;text-align:center}
._dm_statLabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}
._dm_statValue{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
._dm_sections{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;flex-direction:column;display:flex;overflow:hidden}
._dm_sectionHeader{padding:10px 14px;font-weight:600;font-size:13px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}
._dm_sectionBody{padding:8px 14px 14px;display:flex;flex-direction:column;gap:10px}
._dm_field{display:flex;align-items:center;gap:12px;padding:6px 0}
._dm_fieldLabel{flex:none;width:140px;font-size:13px;color:var(--dsw-alias-label-secondary)}
._dm_fieldHint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
._dm_fieldRight{flex:1;display:flex;align-items:center;gap:8px;min-height:32px}
._dm_switch{position:relative;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;transition:background-color .13s;border:none}
._dm_switch[data-on]{background:var(--dsw-alias-state-success-primary,#3fb950)}
._dm_switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .13s}
._dm_switch[data-on]::after{transform:translateX(16px)}
._dm_input{font:inherit;width:80px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
._dm_input:focus{outline:none;border-color:var(--dsw-alias-state-success-primary,#3fb950)}
._dm_footer{flex:none;align-items:center;gap:10px;display:flex}
._dm_save{font:inherit;cursor:pointer;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 14px;font-size:13px;transition:background-color .13s,border-color .13s}
._dm_save:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
._dm_save:disabled{opacity:.55;cursor:default}
._dm_reset{font:inherit;cursor:pointer;background:0 0;border:none;border-radius:6px;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
._dm_reset:hover{color:var(--dsw-alias-label-primary)}
._dm_saved{font-size:12px;color:var(--dsw-alias-state-success-primary,#3fb950);opacity:0;transition:opacity .2s}
._dm_saved[data-show]{opacity:1}
`;
    const styleTagId = "dsh-dream-memory/styles";
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${styleTagId}"]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-dream-memory";
      tag.dataset.pluginCss = styleTagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── 状态管理 ──
    var panelOpen = false;
    var settings = null;
    var fields = null;
    var stats = null;

    const listeners = new Set();
    function notify() { for (const fn of [...listeners]) fn(); }
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

    async function fetchSettings() {
      try {
        const res = await fetch("/api/dsh-dream-memory/settings");
        const body = await res.json();
        if (body.ok === true) { settings = body.values; fields = body.fields; }
      } catch (e) { console.warn("[dsh-dream-memory] settings fetch failed:", e); }
    }

    async function fetchStats() {
      try {
        const res = await fetch("/api/dsh-dream-memory/status");
        const body = await res.json();
        if (body.ok === true) stats = body;
      } catch (e) { console.warn("[dsh-dream-memory] stats fetch failed:", e); }
    }

    async function saveSettings() {
      if (!settings) return;
      try {
        const res = await fetch("/api/dsh-dream-memory/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settings),
        });
        const body = await res.json();
        if (body.ok === true) {
          settings = body.values;
          notify();
          const saved = document.querySelector("._dm_saved");
          if (saved) { saved.dataset.show = ""; setTimeout(() => delete saved.dataset.show, 1500); }
        }
      } catch (e) { console.warn("[dsh-dream-memory] save failed:", e); }
    }

    // ── 面板构建 ──

    function buildFieldRow(key, spec) {
      const row = document.createElement("div");
      row.className = "_dm_field";

      const labelWrap = document.createElement("div");
      labelWrap.style.flex = "none";
      labelWrap.style.width = "140px";
      const label = document.createElement("div");
      label.style.fontSize = "13px";
      label.style.color = "var(--dsw-alias-label-secondary)";
      label.textContent = spec.label;
      const hint = document.createElement("div");
      hint.style.fontSize = "11px";
      hint.style.color = "var(--dsw-alias-label-tertiary)";
      hint.style.marginTop = "2px";
      hint.textContent = spec.hint;
      labelWrap.appendChild(label);
      labelWrap.appendChild(hint);
      row.appendChild(labelWrap);

      const right = document.createElement("div");
      right.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;min-height:32px";

      if (spec.type === "boolean") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "_dm_switch";
        const sync = () => { if (settings[key]) btn.dataset.on = ""; else delete btn.dataset.on; };
        btn.addEventListener("click", () => { settings[key] = !settings[key]; sync(); });
        sync();
        right.appendChild(btn);
      } else if (spec.type === "number") {
        const input = document.createElement("input");
        input.type = "number";
        input.className = "_dm_input";
        input.min = spec.min; input.max = spec.max; input.step = spec.step ?? 1;
        input.value = settings[key];
        input.addEventListener("change", () => {
          const n = Number(input.value);
          if (Number.isFinite(n)) settings[key] = Math.max(spec.min, Math.min(spec.max, n));
        });
        right.appendChild(input);
        const range = document.createElement("span");
        range.style.fontSize = "11px";
        range.style.color = "var(--dsw-alias-label-tertiary)";
        range.textContent = `${spec.min}–${spec.max}`;
        right.appendChild(range);
      }

      row.appendChild(right);
      return row;
    }

    function buildPanel() {
      const panel = document.createElement("div");
      panel.className = "_dm_panel";
      panel.dataset.dmPanel = "";

      // Header
      const header = document.createElement("div");
      header.className = "_dm_header";
      const title = document.createElement("h2");
      title.className = "_dm_title";
      title.textContent = "记忆设置";
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "_dm_close";
      closeBtn.textContent = "✕";
      closeBtn.setAttribute("aria-label", "关闭");
      closeBtn.addEventListener("click", () => { panelOpen = false; applyActive(); notify(); });
      header.appendChild(title);
      header.appendChild(closeBtn);
      panel.appendChild(header);

      // Body
      const body = document.createElement("div");
      body.className = "_dm_body";

      // 状态统计
      if (stats) {
        const statsBox = document.createElement("div");
        statsBox.className = "_dm_stats";
        const items = [
          { label: "记忆条目", value: stats.active ?? 0 },
          { label: "图谱边", value: stats.edges ?? 0 },
          { label: "原始事件", value: stats.messages ?? 0 },
          { label: "FTS 引擎", value: stats.ftsMode ?? "—" },
        ];
        for (const item of items) {
          const cell = document.createElement("div");
          cell.className = "_dm_stat";
          const label = document.createElement("div");
          label.className = "_dm_statLabel";
          label.textContent = item.label;
          const value = document.createElement("div");
          value.className = "_dm_statValue";
          value.textContent = item.value;
          cell.appendChild(label);
          cell.appendChild(value);
          statsBox.appendChild(cell);
        }
        body.appendChild(statsBox);
      }

      // 设置表单
      if (fields && settings) {
        const sections = document.createElement("div");
        sections.className = "_dm_sections";

        const header = document.createElement("div");
        header.className = "_dm_sectionHeader";
        header.textContent = "个性化设置（保存后立即生效）";
        sections.appendChild(header);

        const secBody = document.createElement("div");
        secBody.className = "_dm_sectionBody";
        for (const key of Object.keys(fields)) {
          secBody.appendChild(buildFieldRow(key, fields[key]));
        }
        sections.appendChild(secBody);
        body.appendChild(sections);
      } else {
        const loading = document.createElement("div");
        loading.style.cssText = "padding:40px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px";
        loading.textContent = "正在加载设置…";
        body.appendChild(loading);
      }

      panel.appendChild(body);

      // Footer
      const footer = document.createElement("div");
      footer.className = "_dm_footer";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "_dm_save";
      saveBtn.textContent = "保存设置";
      saveBtn.addEventListener("click", () => saveSettings());
      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "_dm_reset";
      resetBtn.textContent = "恢复默认";
      resetBtn.addEventListener("click", async () => {
        if (!fields) return;
        for (const key of Object.keys(fields)) settings[key] = fields[key].default;
        notify();
        renderPanel();
      });
      const saved = document.createElement("span");
      saved.className = "_dm_saved";
      saved.textContent = "✓ 已保存";
      footer.appendChild(saveBtn);
      footer.appendChild(resetBtn);
      footer.appendChild(saved);
      panel.appendChild(footer);

      return panel;
    }

    var currentContainer = null;

      function ensureContainer() {
        const column = conversationColumn();
        if (column === undefined) return false;
        if (currentContainer?.isConnected) return true;
        currentContainer = document.createElement("div");
        currentContainer.dataset.dmView = "";
        currentContainer.className = "_dm_view";
        column.appendChild(currentContainer);
        return true;
      }


    function renderPanel() {
      if (!ensureContainer()) { return;
        currentContainer.innerHTML = "";
        currentContainer.appendChild(buildPanel());
      }
    }

    // ── 侧边栏入口 ──

    function sidebarRoot() {
      const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (column === null) return undefined;
      return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild;
    }

    function newSessionButton(root) {
      const nested = root.querySelector('button[class*="newSession"]');
      if (nested !== null) return nested;
      for (const child of root.children) if (child.tagName === "BUTTON") return child;
    }

    function createEntry() {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.dataset.dmEntry = "";
      entry.className = "_dm_entry";
      entry.setAttribute("aria-label", "记忆设置");
      entry.setAttribute("title", "记忆设置");
      entry.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2a2.5 2.5 0 0 1 2.5 2.5c0 1.5-1 2-1 3.5h-3c0-1.5-1-2-1-3.5A2.5 2.5 0 0 1 8 2z"/><path d="M6.5 10.5h3M7 12.5h2"/><path d="M8 2V1"/></svg>`;
      const label = document.createElement("span");
      label.className = "_dm_entryLabel";
      label.textContent = "记忆";
      const badge = document.createElement("span");
      badge.className = "_dm_entryBadge";
      badge.textContent = "—";
      entry.appendChild(entry.firstChild);
      entry.appendChild(label);
      entry.appendChild(badge);
      entry.addEventListener("click", () => {
        panelOpen = !panelOpen;
        applyActive();
        notify();
        if (panelOpen) { fetchSettings().then(renderPanel); fetchStats().then(renderPanel); renderPanel(); }
      });
      // 徽标异步更新
      fetchStats().then(() => { if (stats) badge.textContent = String(stats.active ?? 0); });
      return entry;
    }

    function placeEntry(root, entry) {
      const button = newSessionButton(root);
      if (button === undefined) return false;
      if (entry.parentElement !== root) {
        const row = button.closest('[class*="logoRow"]');
        const base = row !== null && row.parentElement === root ? row : button;
        const anchor = base.nextElementSibling;
        root.insertBefore(entry, anchor);
      }
      return true;
    }

    var entryEl = null;

    function mountEntry() {
      if (entryEl?.isConnected) return;
      entryEl = createEntry();
      const tryPlace = () => {
        const root = sidebarRoot();
        if (root === undefined) return;
        if (placeEntry(root, entryEl)) {
          const obs = new MutationObserver(() => {
            if (!root.contains(entryEl)) placeEntry(root, entryEl);
          });
          obs.observe(root, { childList: true, subtree: true });
        }
      };
      tryPlace();
      const wait = new MutationObserver(tryPlace);
      wait.observe(document.body, { childList: true, subtree: true });
    }

    // ── 面板挂载与激活 ──

    function conversationColumn() {
      return document.querySelector('[data-pane="conversation"]') ?? undefined;
    }

    function applyActive() {
      if (panelOpen) {
        document.documentElement.setAttribute("data-dm-active", "");
      } else {
        document.documentElement.removeAttribute("data-dm-active");
      }
    }

    function mountPanel() {
      const column = conversationColumn();
      if (column === undefined) return;
      if (currentContainer?.isConnected) return;
      currentContainer = document.createElement("div");
      currentContainer.dataset.dmView = "";
      currentContainer.className = "_dm_view";
      column.appendChild(currentContainer);
      currentContainer.appendChild(buildPanel());
    }

    const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]';
    function onClickSidebarRow(event) {
      if (!panelOpen) return;
      const target = event.target;
      if (target === null) return;
      if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) {
        panelOpen = false;
        applyActive();
        notify();
      }
    }

    function apply(_ctx) {
      mountEntry();
      mountPanel();
      const waitPanel = new MutationObserver(() => mountPanel());
      waitPanel.observe(document.body, { childList: true, subtree: true });
      document.addEventListener("click", onClickSidebarRow, true);
      subscribe(renderPanel);
      _ctx.effect(() => () => {
        waitPanel.disconnect();
        document.removeEventListener("click", onClickSidebarRow, true);
        document.documentElement.removeAttribute("data-dm-active");
        entryEl?.remove();
        currentContainer?.remove();
      }, "dsh-dream-memory: ui mounts");
    }

    exports.apply = apply;
    exports.inject = [];
    return module.exports;
  }
});
