import React, { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@/ds';
import { Modal } from '@/lib/ui.jsx';

// Janela de confirmação da Kobly no lugar do confirm()/prompt() do navegador (aquela caixa cinza com o
// endereço do site). Uso: if (!(await askConfirm('Excluir?'))) return;  const v = await askPrompt('Novo limite:', '10');
// O <ConfirmHost /> fica montado uma vez na raiz do app.

let push = null;
const queue = [];
function open(req) {
  return new Promise((resolve) => {
    const item = { ...req, resolve };
    if (push) push(item); else queue.push(item);
  });
}
// mensagem com várias frases: a primeira vira o título, o resto fica embaixo
function split(message) {
  const s = String(message || '');
  const m = /^(.+?[?.!])\s+([\s\S]+)$/.exec(s);
  return m && m[1].length <= 90 ? [m[1], m[2]] : [s, null];
}
export function askConfirm(message, opts = {}) {
  const [title, detail] = opts.title ? [opts.title, message] : split(message);
  const danger = opts.danger != null ? opts.danger : /\b(excluir|remover|revogar|desconectar|apagar|descartar)\b/i.test(String(message));
  return open({ kind: 'confirm', title, detail, danger, confirmLabel: opts.confirmLabel || (danger ? 'Sim, continuar' : 'Confirmar') });
}
export function askPrompt(message, initial = '', opts = {}) {
  return open({ kind: 'prompt', title: opts.title || message, detail: opts.title ? message : null, initial: String(initial ?? ''), confirmLabel: opts.confirmLabel || 'Salvar' });
}

export function ConfirmHost() {
  const [cur, setCur] = useState(null);
  const [value, setValue] = useState('');
  const pending = useRef([]);
  useEffect(() => {
    push = (item) => setCur((c) => { if (c) { pending.current.push(item); return c; } setValue(item.initial || ''); return item; });
    while (queue.length) push(queue.shift());
    return () => { push = null; };
  }, []);
  function done(result) {
    cur.resolve(result);
    const next = pending.current.shift() || null;
    if (next) setValue(next.initial || '');
    setCur(next);
  }
  if (!cur) return null;
  const cancel = () => done(cur.kind === 'prompt' ? null : false);
  return (
    <Modal open onClose={cancel} title={cur.title} subtitle={cur.kind === 'confirm' ? cur.detail : null}
      footer={<><Button variant="ghost" onClick={cancel}>Cancelar</Button>
        <Button variant={cur.danger ? 'danger' : 'primary'} autoFocus onClick={() => done(cur.kind === 'prompt' ? value : true)}>{cur.confirmLabel}</Button></>}>
      {cur.kind === 'prompt' && (
        <form onSubmit={(e) => { e.preventDefault(); done(value); }}>
          {cur.detail && <p style={{ margin: '0 0 10px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{cur.detail}</p>}
          <Input value={value} autoFocus onChange={(e) => setValue(e.target.value)} />
        </form>
      )}
    </Modal>
  );
}
