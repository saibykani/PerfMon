import { useState, type FormEvent } from 'react';
import { api } from '@/services/api';
import { Field, Modal } from './ui';

/** Own-password change (POST /auth/change-password). Same rule as the server: 8+ chars, letters and digits. */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const strong = next.length >= 8 && /[A-Za-z]/.test(next) && /\d/.test(next);
  const valid = current.length > 0 && strong && next === confirm;

  const close = () => { setCurrent(''); setNext(''); setConfirm(''); setMsg(null); onClose(); };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid) return;
    setBusy(true); setMsg(null);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      setMsg({ ok: true, text: 'Password changed. Use the new password next time you sign in.' });
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={close} title="Change password" width={420}
      footer={<><button className="btn" onClick={close}>{msg?.ok ? 'Done' : 'Cancel'}</button>
        <button className="btn btn-primary" disabled={!valid || busy} onClick={() => submit()}>{busy ? 'Saving…' : 'Change password'}</button></>}>
      <form className="stack" style={{ gap: 10 }} onSubmit={submit}>
        <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus /></Field>
        <Field label="New password" hint={next && !strong ? 'At least 8 characters with letters and digits' : '8+ characters with letters and digits'}>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirm new password" hint={confirm && confirm !== next ? 'Passwords do not match' : undefined}>
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {msg && <div className={msg.ok ? 'notice' : 'error-box'} role="status">{msg.text}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
