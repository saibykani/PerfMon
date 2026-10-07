import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, Variable as VarIcon } from 'lucide-react';
import { Modal, Field } from '@/components/ui';
import { VARIABLE_TYPES } from './catalog';
import { useVariableOptions } from './Controls';
import type { Variable, VariableType } from './types';

function DefaultPicker({ v, onChange }: { v: Variable; onChange: (val: string | null) => void }) {
  const opts = useVariableOptions(v, {}, [], null);
  const options = v.type === 'custom' ? (v.customValues ?? []).map((c) => ({ value: c, label: c })) : opts.data ?? [];
  return (
    <select className="select" value={v.defaultValue ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Default value">
      <option value="">{v.includeAll !== false ? 'All' : 'Latest / first'}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function VariablesEditor({ open, variables, onClose, onApply }: { open: boolean; variables: Variable[]; onClose: () => void; onApply: (v: Variable[]) => void }) {
  const [list, setList] = useState<Variable[]>(variables);
  const [sel, setSel] = useState(0);
  useEffect(() => { if (open) { setList(structuredClone(variables)); setSel(0); } }, [open, variables]);
  const cur = list[sel];
  const upd = (patch: Partial<Variable>) => setList((l) => l.map((v, i) => (i === sel ? { ...v, ...patch } : v)));
  const add = (type: VariableType = 'environment') => {
    const base = VARIABLE_TYPES.find((t) => t.key === type)!.defaultName;
    let name = base; let n = 2;
    while (list.some((v) => v.name === name)) name = `${base}${n++}`;
    setList((l) => [...l, { name, type, includeAll: true, multi: false, defaultValue: null }]);
    setSel(list.length);
  };
  const move = (d: -1 | 1) => {
    const j = sel + d;
    if (j < 0 || j >= list.length) return;
    setList((l) => { const c = [...l]; [c[sel], c[j]] = [c[j], c[sel]]; return c; });
    setSel(j);
  };
  const names = list.map((v) => v.name);
  const invalid = list.some((v) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v.name)) || new Set(names).size !== names.length;

  return (
    <Modal open={open} onClose={onClose} title="Dashboard variables" width={860}
      footer={<>
        {invalid && <span className="muted" style={{ marginRight: 'auto', color: 'var(--fail)' }}>Variable names must be unique identifiers (letters, digits, _).</span>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={invalid} onClick={() => onApply(list)}>Apply</button>
      </>}>
      <div className="vars-editor">
        <div className="vars-list">
          {list.map((v, i) => (
            <button key={i} className={`vars-item ${i === sel ? 'on' : ''}`} onClick={() => setSel(i)}>
              <span className="mono">${v.name}</span><span className="muted">{VARIABLE_TYPES.find((t) => t.key === v.type)?.label}</span>
            </button>
          ))}
          {!list.length && <div className="muted" style={{ padding: 8, fontSize: 12 }}>No variables yet. Variables become selectors in the dashboard header and filter every panel.</div>}
          <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => add()}><Plus size={13} />Add variable</button>
          <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>Quick add</div>
          <div className="chips" style={{ marginTop: 4 }}>
            {VARIABLE_TYPES.filter((t) => t.key !== 'custom' && !list.some((v) => v.type === t.key)).slice(0, 8).map((t) => <button key={t.key} className="chip" onClick={() => add(t.key)}>${t.defaultName}</button>)}
          </div>
        </div>
        <div className="vars-form">
          {cur ? (
            <div className="stack" style={{ gap: 10 }}>
              <div className="form-grid">
                <Field label="Name" hint={<>Referenced as <span className="mono">${cur.name}</span></>}><input className="input mono" value={cur.name} onChange={(e) => upd({ name: e.target.value.trim() })} aria-label="Variable name" /></Field>
                <Field label="Label"><input className="input" value={cur.label ?? ''} placeholder={cur.name} onChange={(e) => upd({ label: e.target.value || undefined })} aria-label="Variable label" /></Field>
                <Field label="Type">
                  <select className="select" value={cur.type} onChange={(e) => upd({ type: e.target.value as VariableType, defaultValue: null })} aria-label="Variable type">
                    {VARIABLE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                </Field>
                <Field label="Default value"><DefaultPicker v={cur} onChange={(val) => upd({ defaultValue: val })} /></Field>
              </div>
              {cur.type === 'custom' && (
                <Field label="Values" hint="Comma-separated"><input className="input" value={(cur.customValues ?? []).join(', ')} onChange={(e) => upd({ customValues: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} aria-label="Custom values" /></Field>
              )}
              <div className="row wrap" style={{ gap: 16 }}>
                <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!cur.multi} onChange={(e) => upd({ multi: e.target.checked })} />Multi-value</label>
                <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={cur.includeAll !== false} onChange={(e) => upd({ includeAll: e.target.checked })} />Include “All” option</label>
              </div>
              <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <button className="btn btn-sm" onClick={() => move(-1)} disabled={sel === 0}><ArrowUp size={13} />Up</button>
                <button className="btn btn-sm" onClick={() => move(1)} disabled={sel === list.length - 1}><ArrowDown size={13} />Down</button>
                <div className="spacer" />
                <button className="btn btn-sm btn-danger" onClick={() => { setList((l) => l.filter((_, i) => i !== sel)); setSel(Math.max(0, sel - 1)); }}><Trash2 size={13} />Remove</button>
              </div>
            </div>
          ) : (
            <div className="empty"><VarIcon size={22} /><div style={{ marginTop: 6 }}>Add a variable to filter all panels at once.</div></div>
          )}
        </div>
      </div>
    </Modal>
  );
}
