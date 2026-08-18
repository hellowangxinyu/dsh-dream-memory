/**
 * dsh-dream-memory — Settings Section client
 *
 * Registers a "Memory" section under DSH Settings → General Settings.
 * The section shows live stats, personalizable options, and a browsable
 * list of memory entries with full-text detail on click.
 */

window.__ModuleLoader__.load({
  id: "dsh-dream-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");

    // ── scoped styles ──
    const CSS = `
.dm-wrap{display:flex;flex-direction:column;gap:14px;padding:4px 2px}
.dm-stats{display:flex;flex-wrap:wrap;gap:8px}
.dm-stat{flex:1;min-width:110px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:10px 12px}
.dm-statLabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dm-statValue{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.dm-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px}
.dm-cardTitle{font-size:13px;font-weight:600;margin:0 0 8px;color:var(--dsw-alias-label-secondary)}
.dm-field{display:flex;align-items:center;gap:12px;padding:5px 0}
.dm-fieldLabel{flex:none;width:150px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dm-fieldHint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:1px}
.dm-fieldRight{flex:1;display:flex;align-items:center;gap:8px;min-height:30px}
.dm-switch{position:relative;width:34px;height:19px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;border:none;transition:background-color .13s}
.dm-switch[data-on]{background:var(--dsw-alias-state-success-primary,#3fb950)}
.dm-switch::after{content:'';position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .13s}
.dm-switch[data-on]::after{transform:translateX(15px)}
.dm-input{font:inherit;width:76px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dm-save{font:inherit;cursor:pointer;background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 14px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dm-save:hover{background:var(--dsw-alias-interactive-bg-active)}
.dm-saved{font-size:12px;color:var(--dsw-alias-state-success-primary,#3fb950);margin-left:8px}
.dm-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dm-filter{font:inherit;flex:1;min-width:160px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dm-table{width:100%;border-collapse:collapse;font-size:13px}
.dm-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary);font-size:11px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dm-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.dm-row{cursor:pointer}
.dm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dm-detail{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6;max-height:360px;overflow:auto}
.dm-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dm-badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);margin-right:6px}
`;
    const styleId = "dsh-dream-memory/settings-styles";
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${styleId}"]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-dream-memory";
      tag.dataset.pluginCss = styleId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    async function api(path, init) {
      const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok !== true) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return body;
    }

    function MemoryView() {
      const [settings, setSettings] = react.useState(null);
      const [fields, setFields] = react.useState(null);
      const [stats, setStats] = react.useState(null);
      const [memories, setMemories] = react.useState([]);
      const [detail, setDetail] = react.useState(null);
      const [filter, setFilter] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [loading, setLoading] = react.useState(true);

      const load = react.useCallback(async () => {
        try {
          const [s, st, m] = await Promise.all([
            api("/api/dsh-dream-memory/settings"),
            api("/api/dsh-dream-memory/status"),
            api("/api/dsh-dream-memory/memories?limit=50"),
          ]);
          setSettings(s.values);
          setFields(s.fields);
          setStats(st);
          setMemories(m.memories);
        } catch (e) {
          setNotice(String(e.message || e));
        } finally {
          setLoading(false);
        }
      }, []);

      react.useEffect(() => { void load(); }, [load]);

      const save = async () => {
        try {
          const body = await api("/api/dsh-dream-memory/settings", {
            method: "POST",
            body: JSON.stringify(settings),
          });
          setSettings(body.values);
          setNotice("✓ 已保存");
          setTimeout(() => setNotice(""), 1500);
        } catch (e) {
          setNotice(String(e.message || e));
        }
      };

      const openDetail = async (id) => {
        try {
          const body = await api(`/api/dsh-dream-memory/read?id=${encodeURIComponent(id)}`);
          setDetail(body.memory);
        } catch (e) {
          setNotice(String(e.message || e));
        }
      };

      const filtered = memories.filter((m) => {
        if (!filter) return true;
        const q = filter.toLowerCase();
        return (m.summary || "").toLowerCase().includes(q) || (m.kind || "").toLowerCase().includes(q) || (m.scope || "").toLowerCase().includes(q);
      });

      return react.createElement("div", { className: "dm-wrap" },
        // Header
        react.createElement("h2", { style: { margin: "0 0 4px", fontSize: "16px" } }, "记忆 Memory"),
        react.createElement("div", { className: "dm-muted" }, "长期记忆 / 按需召回 / 梦境整理"),

        // Stats
        stats && react.createElement("div", { className: "dm-stats" },
          [["条目", stats.active ?? 0], ["边", stats.edges ?? 0], ["事件", stats.messages ?? 0], ["FTS", stats.ftsMode ?? "—"]].map(([label, value]) =>
            react.createElement("div", { className: "dm-stat", key: label },
              react.createElement("div", { className: "dm-statLabel" }, label),
              react.createElement("div", { className: "dm-statValue" }, String(value))
            )
          )
        ),

        // Settings
        fields && settings && react.createElement("div", { className: "dm-card" },
          react.createElement("p", { className: "dm-cardTitle" }, "个性化设置 / Settings"),
          Object.keys(fields).map((key) => {
            const spec = fields[key];
            if (spec.type === "boolean") {
              return react.createElement("div", { className: "dm-field", key: key },
                react.createElement("div", { className: "dm-fieldLabel" },
                  spec.label,
                  react.createElement("div", { className: "dm-fieldHint" }, spec.hint || "")
                ),
                react.createElement("div", { className: "dm-fieldRight" },
                  react.createElement("button", {
                    type: "button",
                    className: "dm-switch",
                    "data-on": settings[key] ? "" : undefined,
                    onClick: () => setSettings({ ...settings, [key]: !settings[key] }),
                  })
                )
              );
            }
            if (spec.type === "number") {
              return react.createElement("div", { className: "dm-field", key: key },
                react.createElement("div", { className: "dm-fieldLabel" },
                  spec.label,
                  react.createElement("div", { className: "dm-fieldHint" }, spec.hint || "")
                ),
                react.createElement("div", { className: "dm-fieldRight" },
                  react.createElement("input", {
                    type: "number",
                    className: "dm-input",
                    min: spec.min, max: spec.max, step: spec.step || 1,
                    value: settings[key],
                    onChange: (e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) setSettings({ ...settings, [key]: Math.max(spec.min, Math.min(spec.max, n)) });
                    },
                  }),
                  react.createElement("span", { className: "dm-muted" }, `${spec.min}–${spec.max}`)
                )
              );
            }
            return null;
          }),
          react.createElement("div", { style: { marginTop: "10px" } },
            react.createElement("button", { type: "button", className: "dm-save", onClick: save }, "保存设置 / Save"),
            notice && react.createElement("span", { className: "dm-saved" }, notice)
          )
        ),

        // Memory list
        react.createElement("div", { className: "dm-card" },
          react.createElement("p", { className: "dm-cardTitle" }, "记忆内容 / Entries"),
          react.createElement("div", { className: "dm-toolbar" },
            react.createElement("input", {
              className: "dm-filter",
              placeholder: "搜索记忆… / filter by keyword/kind/scope",
              value: filter,
              onChange: (e) => setFilter(e.target.value),
            })
          ),
          loading ? react.createElement("p", { className: "dm-muted" }, "加载中… / Loading…") :
          react.createElement("table", { className: "dm-table" },
            react.createElement("thead", null,
              react.createElement("tr", null,
                react.createElement("th", null, "ID"),
                react.createElement("th", null, "类型 Kind"),
                react.createElement("th", null, "摘要 Summary"),
                react.createElement("th", null, "重要性")
              )
            ),
            react.createElement("tbody", null,
              filtered.map((m) =>
                react.createElement("tr", { className: "dm-row", key: m.id, onClick: () => openDetail(m.id) },
                  react.createElement("td", null, react.createElement("span", { className: "dm-badge" }, m.id.slice(0, 14))),
                  react.createElement("td", null, m.kind),
                  react.createElement("td", null, m.summary),
                  react.createElement("td", null, Number(m.importance ?? 0).toFixed(2))
                )
              )
            )
          )
        ),

        // Detail
        detail && react.createElement("div", { className: "dm-card" },
          react.createElement("p", { className: "dm-cardTitle" }, `详情 ${detail.id}`),
          react.createElement("div", { className: "dm-detail" },
            `[${detail.kind} | ${detail.scope} | ${new Date(detail.created_at).toLocaleString()}]\n${detail.summary}\n\n${detail.content}`
          )
        )
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dream-memory",
        order: 90,
        label: () => "记忆 Memory",
      }, () => react.createElement(MemoryView)));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
