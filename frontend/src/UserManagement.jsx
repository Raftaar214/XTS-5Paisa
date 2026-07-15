import React, { useState, useEffect, useCallback } from "react";
import { X, Plus, Save, Trash2, RotateCcw, Loader, Users } from "lucide-react";

import { API_BASE } from "./authFetch";

const API = API_BASE;// keep in sync with `API` in App.jsx / API_BASE in authFetch.js

const emptyForm = {
  id: "", name: "", role: "CHILD", multiplier: "1",
  rootUrl: "https://xtsmum.5paisa.com", source: "WEBAPI",
  assignedTo: "",
  interactiveKey: "", interactiveSecret: "",
  marketKey: "", marketSecret: "",
  enabled: true,
};

const inputCls = "w-full bg-[#161a1f] border border-gray-600 text-white text-[12px] px-2 py-1.5 rounded-sm focus:outline-none focus:border-blue-500";

function FormRow({ label, children }) {
  return (
    <div className="mb-2">
      <div className="text-[10px] text-gray-500 mb-0.5">{label}</div>
      {children}
    </div>
  );
}

export default function UserManagement({ onClose, onClientsChanged }) {
  const [rows, setRows]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [busyId, setBusyId]       = useState(null);
  const [error, setError]         = useState("");
  const [notice, setNotice]       = useState("");
  const [editingId, setEditingId] = useState(null);
  const [form, setForm]           = useState(emptyForm);
  const [roleInitialized, setRoleInitialized] = useState(false);
  const [dashboardUsers, setDashboardUsers] = useState([]); // configured login usernames, for "Assigned To"
  const [myUsername, setMyUsername] = useState("");

  useEffect(() => {
  const loadDashboardData = async () => {
    try {
      const r = await fetch(`${API}/api/auth/users`);

      if (!r.ok) {
        setDashboardUsers([]);
      } else {
        const users = await r.json();
        setDashboardUsers(Array.isArray(users) ? users : []);
      }

      const token = localStorage.getItem("xts_dashboard_token");

      if (token) {
        const vr = await fetch(`${API}/api/auth/verify`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        const vd = await vr.json();

        if (vd.valid) {
          setMyUsername(vd.username);
        }
      }
    } catch (err) {
      console.error(err);
      setDashboardUsers([]);
    }
  };

  loadDashboardData();
}, []);

  const notifyParent = () => { onClientsChanged && onClientsChanged(); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/clients/full`);

if (!r.ok) {
  setRows([]);
  return;
}

const d = await r.json();

const list = Array.isArray(d) ? d : [];
      setRows(list);
      if (!roleInitialized) {
        // First load: default a brand-new form to "Parent" if none exists yet
        // (guides first-run setup), otherwise "Child" (the common case).
        setForm(f => ({ ...f, role: list.some(c => c.role === "PARENT") ? "CHILD" : "PARENT" }));
        setRoleInitialized(true);
      }
    } catch (e) {
      setError("Could not load clients: " + e.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleInitialized]);

  useEffect(() => { load(); }, [load]);

  const resetForm = () => {
    setForm({ ...emptyForm, role: rows.some(r => r.role === "PARENT") ? "CHILD" : "PARENT", assignedTo: myUsername || "" });
    setEditingId(null);
    setError(""); setNotice("");
  };

  const startEdit = (row) => {
    setEditingId(row.id);
    setForm({
      id: row.id, name: row.name, role: row.role,
      multiplier: String(row.multiplier || 1),
      rootUrl: row.rootUrl || "https://xtsmum.5paisa.com",
      source: row.source || "WEBAPI",
      assignedTo: row.assignedTo || "",
      interactiveKey: "", interactiveSecret: "",
      marketKey: "", marketSecret: "",
      enabled: row.enabled,
    });
    setError(""); setNotice("");
  };

  const parentExists   = rows.some(r => r.role === "PARENT");
  const editingParent  = !!editingId && rows.find(r => r.id === editingId)?.role === "PARENT";

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setNotice("");

    if (!form.id.trim() || !form.name.trim()) {
      setError("Client ID and Client Name are required"); return;
    }
    if (form.role === "CHILD" && (!Number(form.multiplier) || Number(form.multiplier) <= 0)) {
      setError("Multiplier must be a positive number for a child client"); return;
    }
    if (!editingId) {
      if (form.role === "CHILD" && (!form.interactiveKey || !form.interactiveSecret)) {
        setError("Interactive API Key and Secret are required for a child client"); return;
      }
      if (form.role === "PARENT" && (!form.interactiveKey || !form.interactiveSecret || !form.marketKey || !form.marketSecret || !form.rootUrl)) {
        setError("Parent requires Root URL + Interactive API + Market Data API (all fields)"); return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        id: form.id.trim(), name: form.name.trim(), role: form.role,
        multiplier: Number(form.multiplier) || 1,
        rootUrl: form.rootUrl.trim(), source: form.source,
        assignedTo: form.assignedTo || "",
        enabled: form.enabled,
      };
      if (form.interactiveKey)    payload.interactiveKey    = form.interactiveKey.trim();
      if (form.interactiveSecret) payload.interactiveSecret = form.interactiveSecret.trim();
      if (form.role === "PARENT") {
        if (form.marketKey)    payload.marketKey    = form.marketKey.trim();
        if (form.marketSecret) payload.marketSecret = form.marketSecret.trim();
      }

      const url    = editingId ? `${API}/api/clients/${encodeURIComponent(editingId)}` : `${API}/api/clients`;
      const method = editingId ? "PUT" : "POST";
      const r = await fetch(url, { method, headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${localStorage.getItem("xts_dashboard_token")}`,
}, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "Save failed");

      setNotice(editingId ? `Updated ${payload.name}` : `Added ${payload.role === "PARENT" ? "parent" : "child"} ${payload.name}`);
      setEditingId(null);
      setForm({ ...emptyForm, role: "CHILD", assignedTo: myUsername || "" });
      await load();
      notifyParent();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm(`Delete client ${id}? This cannot be undone.`)) return;
    setBusyId(id);
    try {
      const r = await fetch(`${API}/api/clients/${encodeURIComponent(id)}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || "Delete failed");
      if (editingId === id) resetForm();
      await load();
      notifyParent();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const doLogin = async (id) => {
    setBusyId(id); setError("");
    try {
      const r = await fetch(`${API}/api/clients/${id}/login`, { method: "POST" });
      const d = await r.json();
      if (d.status === "login_failed") setError(d.error);
      await load(); notifyParent();
    } catch (err) { setError(err.message); }
    finally { setBusyId(null); }
  };
  const doLogout = async (id) => {
    setBusyId(id);
    try {
      await fetch(`${API}/api/clients/${id}/logout`, { method: "POST" });
      await load(); notifyParent();
    } catch (err) { setError(err.message); }
    finally { setBusyId(null); }
  };
  const doConnect = async (id) => {
    setBusyId(id); setError("");
    try {
      const r = await fetch(`${API}/api/clients/${id}/connect`, { method: "POST" });
      const d = await r.json();
      if (d.error) setError(d.error);
      await load(); notifyParent();
    } catch (err) { setError(err.message); }
    finally { setBusyId(null); }
  };
  const doDisconnect = async (id) => {
    setBusyId(id);
    try {
      await fetch(`${API}/api/clients/${id}/disconnect`, { method: "POST" });
      await load(); notifyParent();
    } catch (err) { setError(err.message); }
    finally { setBusyId(null); }
  };
  const toggleTrading = async (row) => {
    setBusyId(row.id);
    try {
      await fetch(`${API}/api/clients/${row.id}/toggle`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !row.enabled }),
      });
      await load(); notifyParent();
    } catch (err) { setError(err.message); }
    finally { setBusyId(null); }
  };

  const parentCount = rows.filter(r => r.role === "PARENT").length;
  const childCount  = rows.length - parentCount;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-[980px] max-h-[92vh] bg-[#1b2027] border border-gray-700 rounded-lg shadow-2xl flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-[#8a5a1f] to-[#6b4419] border-b border-gray-700 shrink-0">
          <div className="flex items-center gap-2 text-white font-bold text-sm">
            <Users size={16} /> USER MANAGEMENT ({parentCount} parent + {childCount} children)
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white"><X size={18} /></button>
        </div>

        {!loading && !parentExists && (
          <div className="mx-4 mt-3 text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-sm px-2 py-1.5">
            No Parent client configured yet. Add one first below — set <b>Role = Parent</b> (Market Data API is mandatory for the parent).
          </div>
        )}

        {/* Table */}
        <div className="overflow-auto px-4 pt-3" style={{ maxHeight: "34vh" }}>
          {loading ? (
            <div className="text-center text-gray-400 text-xs py-6 flex items-center justify-center gap-2">
              <Loader size={14} className="animate-spin" /> Loading clients…
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center text-gray-500 text-xs py-6">No clients yet — add a Parent client below to get started.</div>
          ) : (
            <table className="w-full text-left border-collapse text-[11px]">
              <thead>
                <tr className="text-gray-400 uppercase tracking-wide border-b border-gray-700">
                  <th className="py-1.5 pr-2">Client Name</th>
                  <th className="py-1.5 pr-2">Client ID</th>
                  <th className="py-1.5 pr-2">Role</th>
                  <th className="py-1.5 pr-2">Assigned To</th>
                  <th className="py-1.5 pr-2">Mult ×</th>
                  <th className="py-1.5 pr-2">Int Login</th>
                  <th className="py-1.5 pr-2">Int WS</th>
                  <th className="py-1.5 pr-2">Trading</th>
                  <th className="py-1.5 pr-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className={`border-b border-gray-800 ${editingId === row.id ? "bg-[#2a2f38]" : ""}`}>
                    <td className="py-1.5 pr-2 text-gray-100">{row.name}</td>
                    <td className="py-1.5 pr-2 font-mono text-gray-400">{row.id}</td>
                    <td className="py-1.5 pr-2">
                      <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${row.role === "PARENT" ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" : "bg-blue-500/20 text-blue-400 border border-blue-500/30"}`}>
                        {row.role}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-gray-300">
                      {row.assignedTo
                        ? <span className="px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30">{row.assignedTo}</span>
                        : <span className="text-gray-500 text-[9px]">everyone</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-gray-300">{row.role === "PARENT" ? "—" : `${row.multiplier}x`}</td>
                    <td className="py-1.5 pr-2">
                      <button disabled={busyId === row.id} onClick={() => row.isLogged ? doLogout(row.id) : doLogin(row.id)}
                        className={`px-1.5 py-0.5 rounded-sm text-[9px] font-semibold ${row.isLogged ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-gray-600/30 text-gray-400 border border-gray-600/40"}`}>
                        {busyId === row.id ? "…" : row.isLogged ? "IN" : "OUT"}
                      </button>
                    </td>
                    <td className="py-1.5 pr-2">
                      <button disabled={busyId === row.id || !row.isLogged} onClick={() => row.isConnected ? doDisconnect(row.id) : doConnect(row.id)}
                        className={`px-1.5 py-0.5 rounded-sm text-[9px] font-semibold disabled:opacity-40 ${row.isConnected ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-gray-600/30 text-gray-400 border border-gray-600/40"}`}>
                        {row.isConnected ? "ON" : "OFF"}
                      </button>
                    </td>
                    <td className="py-1.5 pr-2">
                      <button disabled={busyId === row.id} onClick={() => toggleTrading(row)}
                        className={`px-1.5 py-0.5 rounded-sm text-[9px] font-semibold ${row.enabled ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-red-500/10 text-red-400 border border-red-500/20"}`}>
                        {row.enabled ? "OK" : "OFF"}
                      </button>
                    </td>
                    <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                      <button onClick={() => startEdit(row)} className="text-[9px] px-1.5 py-0.5 mr-1 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 rounded-sm text-gray-200">Edit</button>
                      <button disabled={busyId === row.id} onClick={() => remove(row.id)} className="text-[9px] px-1.5 py-0.5 bg-red-600/20 hover:bg-red-600/40 border border-red-600/30 rounded-sm text-red-400">Del</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Add / Edit form */}
        <form onSubmit={submit} className="px-4 py-3 border-t border-gray-700 overflow-y-auto">
          <div className="text-white text-xs font-bold mb-2">{editingId ? `Edit Client — ${editingId}` : "Add New Client"}</div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Identity */}
            <div>
              <div className="text-[10px] text-gray-500 uppercase font-semibold mb-1.5">Identity</div>
              <FormRow label="Client Name">
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className={inputCls} placeholder="e.g. ABHISHEK KHANDAL" />
              </FormRow>
              <FormRow label="Client ID">
                <input value={form.id} disabled={!!editingId} onChange={e => setForm(f => ({ ...f, id: e.target.value }))}
                  className={`${inputCls} ${editingId ? "opacity-50 cursor-not-allowed" : ""}`} placeholder="e.g. 55583335" />
              </FormRow>
              <FormRow label="Root URL">
                <input value={form.rootUrl} onChange={e => setForm(f => ({ ...f, rootUrl: e.target.value }))}
                  className={inputCls} placeholder="https://xtsmum.5paisa.com" />
              </FormRow>
              <FormRow label="Role">
                <select value={form.role} disabled={!!editingId}
                  onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  className={`${inputCls} ${editingId ? "opacity-50 cursor-not-allowed" : ""}`}>
                  <option value="CHILD">Child</option>
                  <option value="PARENT" disabled={parentExists && !editingParent}>
                    Parent {parentExists && !editingParent ? "(already exists)" : ""}
                  </option>
                </select>
              </FormRow>
              <FormRow label="Assigned To">
  <select
    value={form.assignedTo}
    onChange={e => setForm(f => ({ ...f, assignedTo: e.target.value }))}
    className={inputCls}
  >
    <option value="">Everyone (unassigned)</option>

    {(Array.isArray(dashboardUsers) ? dashboardUsers : []).map((u) => (
      <option key={u} value={u}>
        {u}{u === myUsername ? " (you)" : ""}
      </option>
    ))}
  </select>

  <div className="text-[9px] text-gray-500 mt-0.5">
    Only this dashboard login will see/trade this client. Leave as
    "Everyone" to keep it shared.
  </div>
</FormRow>
              {form.role === "CHILD" && (
                <FormRow label="Multiplier ×">
                  <input type="number" min="0.1" step="0.1" value={form.multiplier}
                    onChange={e => setForm(f => ({ ...f, multiplier: e.target.value }))}
                    className={inputCls} placeholder="e.g. 2 for 2x parent size" />
                </FormRow>
              )}
            </div>

            {/* Credentials */}
            <div>
              <div className="text-[10px] text-gray-500 uppercase font-semibold mb-1.5">
                XTS Interactive API {form.role === "PARENT" && <span className="text-amber-500">(mandatory)</span>}
              </div>
              <FormRow label="API Key">
                <input value={form.interactiveKey} onChange={e => setForm(f => ({ ...f, interactiveKey: e.target.value }))}
                  className={inputCls} placeholder={editingId ? "Leave blank to keep existing" : "Interactive API Key"} />
              </FormRow>
              <FormRow label="Secret Key">
                <input value={form.interactiveSecret} onChange={e => setForm(f => ({ ...f, interactiveSecret: e.target.value }))}
                  className={inputCls} placeholder={editingId ? "Leave blank to keep existing" : "Interactive Secret Key"} />
              </FormRow>

              {form.role === "PARENT" && (
                <>
                  <div className="text-[10px] text-gray-500 uppercase font-semibold mb-1.5 mt-3">
                    Market Data API <span className="text-amber-500">(mandatory for parent)</span>
                  </div>
                  <FormRow label="Market Key">
                    <input value={form.marketKey} onChange={e => setForm(f => ({ ...f, marketKey: e.target.value }))}
                      className={inputCls} placeholder={editingId ? "Leave blank to keep existing" : "Market Data API Key"} />
                  </FormRow>
                  <FormRow label="Market Secret">
                    <input value={form.marketSecret} onChange={e => setForm(f => ({ ...f, marketSecret: e.target.value }))}
                      className={inputCls} placeholder={editingId ? "Leave blank to keep existing" : "Market Data Secret Key"} />
                  </FormRow>
                </>
              )}
            </div>
          </div>

          {error  && <div className="mt-3 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1.5">{error}</div>}
          {notice && <div className="mt-3 text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-sm px-2 py-1.5">{notice}</div>}

          <div className="flex items-center gap-2 mt-3">
            <button type="submit" disabled={saving}
              className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-semibold px-3 py-1.5 rounded-sm">
              {saving ? <Loader size={12} className="animate-spin" /> : editingId ? <Save size={12} /> : <Plus size={12} />}
              {editingId ? "Update Selected" : "Add User"}
            </button>
            <button type="button" onClick={resetForm}
              className="flex items-center gap-1.5 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 text-gray-200 text-[11px] px-3 py-1.5 rounded-sm">
              <RotateCcw size={12} /> Clear Form
            </button>
            {editingId && (
              <button type="button" onClick={() => remove(editingId)}
                className="flex items-center gap-1.5 bg-red-600/20 hover:bg-red-600/40 border border-red-600/30 text-red-400 text-[11px] px-3 py-1.5 rounded-sm ml-auto">
                <Trash2 size={12} /> Delete
              </button>
            )}
          </div>
        </form>

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 px-4 py-2.5 border-t border-gray-700 bg-[#1e2329] shrink-0">
          <div className="text-[10px] text-gray-500">
            Parent = Interactive + Market Data API (mandatory). Child = Interactive API only, sized by Multiplier ×.
            Assign a client to one dashboard login to hide it from everyone else's view and EXECUTE.
            <br />Saved automatically to <code className="text-gray-400">backend/data/clients.json</code>
          </div>
          <button onClick={onClose} className="shrink-0 bg-[#2d333b] hover:bg-[#3b4148] border border-gray-600 text-gray-200 text-[11px] px-4 py-1.5 rounded-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}