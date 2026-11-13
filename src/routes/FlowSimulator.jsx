import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/ds';
import { startSim, reply, choose, simVars } from '@/lib/flowSim.js';

// Simulador do fluxo no visual do WhatsApp (abre no "Conferir" do editor). Conversa como "Maria Silva",
// um contato de teste: nada é enviado e nenhuma conexão é usada. O bloco em execução fica destacado no editor.
// Mensagens aparecem uma de cada vez (com "Aguardando…" nos blocos Esperar), como no WhatsApp de verdade.

const CSS = `
.ksim { width: 380px; flex: none; display: flex; flex-direction: column; border-radius: 16px; overflow: hidden; border: 1px solid rgba(var(--fg-rgb), .08);
  background: var(--wa-bg); box-shadow: 0 18px 50px rgba(0,0,0,.35); min-height: 0; animation: ksim-in .25s ease both; }
@keyframes ksim-in { from { opacity: 0; transform: translateX(14px); } }
.ksim-hd { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--wa-panel); border-bottom: 1px solid var(--wa-line); }
.ksim-av { width: 38px; height: 38px; border-radius: 50%; background: #6b7c85; display: grid; place-items: center; color: #fff; position: relative; flex: none; }
.ksim-av i { position: absolute; right: -2px; bottom: -2px; width: 16px; height: 16px; border-radius: 50%; background: #25d366; display: grid; place-items: center; border: 2px solid var(--wa-panel); }
.ksim-hd b { color: var(--wa-text); font-size: 15px; } .ksim-hd small { display: block; color: var(--wa-muted); font-size: 12px; }
.ksim-ib { width: 32px; height: 32px; border-radius: 50%; border: 0; background: transparent; color: var(--wa-icon); cursor: pointer; display: grid; place-items: center; }
.ksim-ib:hover { background: rgba(var(--fg-rgb), .06); }
.ksim-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 12px; display: flex; flex-direction: column; gap: 6px;
  background-image: radial-gradient(rgba(255,148,82,.07) 1px, transparent 1px), radial-gradient(rgba(var(--fg-rgb), .035) 1px, transparent 1px);
  background-size: 22px 22px, 13px 13px; background-position: 0 0, 7px 9px; }
.ksim-msg { max-width: 82%; padding: 6px 8px 4px; border-radius: 9px; font-size: 14px; line-height: 1.4; color: var(--wa-text); white-space: pre-wrap; word-break: break-word; position: relative; animation: ksim-pop .18s ease both; box-shadow: 0 1px .5px rgba(0,0,0,.13); }
@keyframes ksim-pop { from { opacity: 0; transform: translateY(5px) scale(.98); } }
.ksim-msg.out { align-self: flex-end; background: var(--wa-out); border-top-right-radius: 2px; }
.ksim-msg.in { align-self: flex-start; background: var(--wa-in); border-top-left-radius: 2px; }
.ksim-msg.ai { outline: 1px dashed rgba(167,139,250,.6); }
.ksim-msg.on { box-shadow: 0 0 0 2px #ff9452, 0 0 18px rgba(255,98,1,.45); }
.ksim-msg .t { float: right; margin: 6px 0 -2px 10px; font-size: 11px; color: var(--wa-muted); display: inline-flex; align-items: center; gap: 2px; }
.ksim-msg img, .ksim-msg video { display: block; width: 100%; max-height: 300px; object-fit: cover; border-radius: 6px; margin-bottom: 4px; background: rgba(0,0,0,.2); }
.ksim-msg audio { width: 240px; max-width: 100%; display: block; }
.ksim-doc { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 7px; background: rgba(0,0,0,.14); margin-bottom: 4px; font-size: 13px; }
.ksim-btns { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; border-top: 1px solid rgba(var(--fg-rgb), .08); }
.ksim-btns span { text-align: center; color: #53bdeb; padding: 7px 4px 3px; font-size: 14px; }
.ksim-sys { align-self: center; max-width: 92%; display: inline-flex; align-items: flex-start; gap: 7px; padding: 6px 11px; border-radius: 8px; font-size: 12.5px; line-height: 1.35;
  color: var(--wa-text2); background: var(--wa-chip); box-shadow: 0 1px .5px rgba(0,0,0,.13); animation: ksim-pop .18s ease both; }
.ksim-sys svg { flex: none; margin-top: 1px; color: var(--wa-muted); }
.ksim-sys.warn { color: #fcd34d; background: rgba(245,158,11,.14); } .ksim-sys.warn svg { color: #fbbf24; }
.ksim-sys.note { opacity: .92; } .ksim-sys.ask { color: var(--wa-text); box-shadow: inset 0 0 0 1px rgba(255,148,82,.5); }
.ksim-sys small { display: block; color: var(--wa-muted); margin-top: 2px; }
.ksim-choices { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; padding: 4px 0 2px; }
.ksim-choices button { border: 1px solid rgba(255,148,82,.55); background: rgba(255,98,1,.12); color: var(--wa-text); padding: 6px 12px; border-radius: 999px; font-size: 13px; cursor: pointer; font-family: inherit; }
.ksim-choices button:hover { background: rgba(255,98,1,.25); }
.ksim-choices button.ghost { border-color: var(--wa-line); background: transparent; color: var(--wa-muted); }
.ksim-typing { align-self: flex-start; background: var(--wa-in); border-radius: 9px; padding: 9px 12px; display: inline-flex; gap: 4px; }
.ksim-typing i { width: 7px; height: 7px; border-radius: 50%; background: var(--wa-muted); animation: ksim-dot 1s infinite; } .ksim-typing i:nth-child(2) { animation-delay: .15s; } .ksim-typing i:nth-child(3) { animation-delay: .3s; }
@keyframes ksim-dot { 50% { opacity: .3; transform: translateY(-2px); } }
.ksim-ft { padding: 8px 10px 10px; background: var(--wa-panel); border-top: 1px solid var(--wa-line); display: flex; flex-direction: column; gap: 8px; }
.ksim-vars { border-radius: 10px; background: var(--wa-chip); color: var(--wa-text2); font-size: 13px; }
.ksim-vars > button { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: transparent; border: 0; color: inherit; cursor: pointer; font-family: inherit; font-size: 13px; }
.ksim-vars > button em { font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: rgba(var(--fg-rgb), .08); }
.ksim-vars dl { margin: 0; padding: 0 10px 10px; display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; max-height: 160px; overflow: auto; font-size: 12px; }
.ksim-vars dt { color: var(--wa-muted); font-family: var(--font-mono); } .ksim-vars dd { margin: 0; color: var(--wa-text); word-break: break-word; }
.ksim-in { display: flex; gap: 8px; align-items: center; }
.ksim-in input { flex: 1; min-width: 0; border-radius: 10px; border: 1px solid rgba(255,148,82,.55); background: var(--wa-btn); color: var(--wa-text); padding: 10px 12px; font-size: 14px; font-family: inherit; outline: none; }
.ksim-in input:disabled { opacity: .55; border-color: var(--wa-line); }
.ksim-send { width: 40px; height: 40px; border-radius: 50%; border: 0; background: #00a884; color: #fff; display: grid; place-items: center; cursor: pointer; flex: none; }
.ksim-send:disabled { background: var(--wa-btn); color: var(--wa-muted); cursor: default; }
.ksim-intro { margin: auto 6px; padding: 18px; border-radius: 14px; background: var(--wa-panel); border: 1px solid var(--wa-line); color: var(--wa-text); display: flex; flex-direction: column; gap: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.3); }
.ksim-intro h4 { margin: 0; font-size: 17px; } .ksim-intro p { margin: 0; color: var(--wa-text2); font-size: 13.5px; line-height: 1.5; }
.ksim-intro ul { margin: 0; padding: 10px 0 0; list-style: none; display: flex; flex-direction: column; gap: 7px; border-top: 1px solid var(--wa-line); font-size: 12.5px; color: var(--wa-text2); }
.ksim-intro li { display: flex; gap: 8px; align-items: flex-start; } .ksim-intro li svg { flex: none; color: var(--wa-muted); margin-top: 1px; }
.ksim-go { margin-top: 4px; border: 0; border-radius: 999px; padding: 11px; font-weight: 700; font-size: 14px; cursor: pointer; color: #fff; font-family: inherit;
  background: linear-gradient(135deg, #f39200, #ff6201); box-shadow: 0 8px 22px rgba(255,98,1,.4); display: inline-flex; gap: 8px; align-items: center; justify-content: center; }
@media (max-width: 900px) { .ksim { position: absolute; inset: 0; width: auto; z-index: 20; } }
`;

const hora = (d) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
// *negrito* _itálico_ ~riscado~ como no WhatsApp
function Rich({ text }) {
  const parts = String(text || '').split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|https?:\/\/\S+)/g);
  return parts.map((p, i) => {
    if (/^\*[^*]+\*$/.test(p)) return <b key={i}>{p.slice(1, -1)}</b>;
    if (/^_[^_]+_$/.test(p)) return <i key={i}>{p.slice(1, -1)}</i>;
    if (/^~[^~]+~$/.test(p)) return <s key={i}>{p.slice(1, -1)}</s>;
    if (/^https?:\/\//.test(p)) return <a key={i} href={p} target="_blank" rel="noreferrer" style={{ color: '#53bdeb', wordBreak: 'break-all' }}>{p}</a>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}
const SYS_ICON = { zap: 'zap', clock: 'clock', keyboard: 'keyboard', 'git-branch': 'git-branch', tag: 'tag', bell: 'bell', target: 'target', flag: 'flag', mail: 'mail', bot: 'bot', 'credit-card': 'credit-card',
  receipt: 'receipt', split: 'split', 'flag-triangle-right': 'flag-triangle-right', 'calendar-clock': 'calendar-clock', pencil: 'pencil', 'git-merge': 'git-merge', webhook: 'webhook', 'phone-call': 'phone-call', hand: 'hand', check: 'check', instagram: 'instagram', 'corner-down-right': 'corner-down-right', send: 'send' };

function Item({ it, active }) {
  const t = <span className="t">{hora(it.at)}{it.kind !== 'in' && <Icon name="check-check" size={14} style={{ color: '#53bdeb' }} />}</span>;
  if (it.kind === 'sys') return (
    <div className={`ksim-sys ${it.tone || ''}`}><Icon name={SYS_ICON[it.icon] || 'info'} size={14} /><span>{it.text}{it.detail && <small>{it.detail}</small>}</span></div>
  );
  if (it.kind === 'media') {
    const cap = it.caption ? <><Rich text={it.caption} />{t}</> : t;
    let body;
    if (!it.url) body = <div className="ksim-doc"><Icon name="triangle-alert" size={18} />{it.media === 'audio' ? 'Áudio' : it.media === 'video' ? 'Vídeo' : it.media === 'document' ? 'Arquivo' : 'Imagem'} sem arquivo</div>;
    else if (it.media === 'image') body = <img src={it.url} alt="" />;
    else if (it.media === 'video') body = <video src={it.url} controls preload="metadata" />;
    else if (it.media === 'audio') body = <audio src={it.url} controls preload="none" />;
    else body = <div className="ksim-doc"><Icon name="file-text" size={22} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name || 'Documento'}</span><a href={it.url} target="_blank" rel="noreferrer" style={{ color: '#53bdeb' }}><Icon name="download" size={16} /></a></div>;
    return <div className={`ksim-msg out${active ? ' on' : ''}`} style={{ padding: 4 }}>{body}<div style={{ padding: '0 4px' }}>{cap}</div></div>;
  }
  return (
    <div className={`ksim-msg ${it.kind === 'in' ? 'in' : 'out'}${it.ai ? ' ai' : ''}${active ? ' on' : ''}`}>
      <Rich text={it.text} />{t}
      {it.buttons && it.buttons.length > 0 && <div className="ksim-btns">{it.buttons.map((b) => <span key={b}>{b}</span>)}</div>}
    </div>
  );
}

export function FlowSimulator({ graph, lookups, onStep, onClose }) {
  const [st, setSt] = useState(null);
  const [shown, setShown] = useState(0); // quantos itens do log já apareceram
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const [varsOpen, setVarsOpen] = useState(false);
  const body = useRef(null);
  const started = !!st;

  const begin = () => { setShown(0); setSt(startSim(graph(), { lookups })); };
  // revela o log aos poucos (o bloco Esperar dá uma pausa maior)
  useEffect(() => {
    if (!st || shown >= st.log.length) { setTyping(false); return undefined; }
    const it = st.log[shown];
    const prev = st.log[shown - 1];
    const wait = shown === 0 ? 150 : prev && prev.pause ? prev.pause : it.kind === 'in' ? 60 : it.kind === 'sys' ? 260 : 520;
    setTyping(it.kind === 'out' || it.kind === 'media');
    const tm = setTimeout(() => setShown((n) => n + 1), wait);
    return () => clearTimeout(tm);
  }, [st, shown]);
  const caught = st && shown >= st.log.length;
  useEffect(() => { if (body.current) body.current.scrollTop = body.current.scrollHeight; }, [shown, typing, caught]);
  // destaca no editor o bloco que acabou de rodar
  const lastIdx = useMemo(() => { if (!st) return -1; for (let i = Math.min(shown, st.log.length) - 1; i >= 0; i--) if (st.log[i].ref) return i; return -1; }, [st, shown]);
  const lastRef = st && lastIdx >= 0 ? st.log[lastIdx].ref : null;
  useEffect(() => { if (!st) return; const ref = caught && st.wait ? st.wait.ref : lastRef; if (ref) onStep(ref, !!(caught && st.wait)); }, [lastRef, caught]); // eslint-disable-line react-hooks/exhaustive-deps

  // o motor muda o estado no lugar: chama uma vez só (fora do setState, que o StrictMode roda duas vezes)
  const act = (fn) => { if (!st) return; const next = fn(st); setSt({ ...next }); };
  const send = () => { const v = text.trim(); if (!v || !st || !st.wait || st.wait.kind === 'choose' || !caught) return; setText(''); act((s) => reply(s, v)); };
  const w = caught && st && st.wait;
  const canType = !!(w && w.kind !== 'choose');
  const vars = st ? simVars(st) : [];

  return (
    <div className="ksim" role="complementary" aria-label="Simulador do fluxo">
      <style>{CSS}</style>
      <div className="ksim-hd">
        <span className="ksim-av"><Icon name="user-round" size={20} /><i><Icon name="phone" size={8} /></i></span>
        <div style={{ flex: 1, minWidth: 0 }}><b>Maria Silva</b><small>Contato de teste · WhatsApp</small></div>
        {started && <button type="button" className="ksim-ib" title="Recomeçar o teste" aria-label="Recomeçar o teste" onClick={begin}><Icon name="rotate-ccw" size={17} /></button>}
        <button type="button" className="ksim-ib" title="Fechar" aria-label="Fechar simulador" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <div className="ksim-body" ref={body}>
        {!started ? (
          <div className="ksim-intro">
            <svg width="40" height="40" viewBox="0 0 32 32" aria-hidden="true"><path fill="#25d366" d="M16 3C8.8 3 3 8.7 3 15.8c0 2.5.7 4.9 2 6.9L3 29l6.5-2c1.9 1 4.1 1.6 6.5 1.6 7.2 0 13-5.7 13-12.8S23.2 3 16 3Zm0 23.3c-2.1 0-4.1-.6-5.8-1.7l-.4-.2-3.9 1.2 1.2-3.7-.3-.4a10.4 10.4 0 0 1-1.7-5.7C5.1 10 10 5.3 16 5.3S26.9 10 26.9 15.8 22 26.3 16 26.3Zm6-7.8c-.3-.2-1.9-1-2.2-1s-.5-.2-.7.2-.8 1-1 1.2-.4.2-.7.1a8.8 8.8 0 0 1-4.4-3.8c-.3-.6.3-.5.9-1.7.1-.2 0-.4 0-.5l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4s-1 1-1 2.4 1 2.8 1.2 3 2 3.1 4.9 4.3c1.8.8 2.5.8 3.4.7.6-.1 1.9-.8 2.1-1.5s.3-1.3.2-1.5-.3-.2-.6-.4Z" /></svg>
            <h4>Teste o fluxo antes de ativar</h4>
            <p>Você conversa como Maria Silva, um contato de teste, no visual do WhatsApp. Nada é enviado e nenhuma conexão é usada.</p>
            <ul>
              <li><Icon name="mouse-pointer-click" size={14} />Responda digitando ou tocando nos botões</li>
              <li><Icon name="scan-eye" size={14} />O bloco em execução fica destacado no editor</li>
              <li><Icon name="shield-check" size={14} />Etiquetas, pixels, webhooks e alertas só aparecem como aviso</li>
              <li><Icon name="sparkles" size={14} />IA, pagamento e ligação viram uma escolha sua na tela</li>
            </ul>
            <button type="button" className="ksim-go" onClick={begin}><Icon name="play" size={15} />Iniciar teste</button>
          </div>
        ) : (
          <>
            {st.log.slice(0, shown).map((it, i) => <Item key={it.id} it={it} active={i === lastIdx} />)}
            {typing && !caught && <div className="ksim-typing" aria-label="digitando"><i /><i /><i /></div>}
            {w && w.kind === 'choose' && <div className="ksim-choices">{w.options.map((o) => <button key={o.id} type="button" title={o.hint || ''} onClick={() => act((s) => choose(s, o.id))}>{o.label}</button>)}</div>}
            {w && w.kind === 'buttons' && <div className="ksim-choices">{w.options.map((o) => <button key={o.id} type="button" onClick={() => act((s) => reply(s, o.label))}>{o.label}</button>)}<button type="button" className="ghost" onClick={() => act((s) => choose(s, 'timeout'))}>Não responder</button></div>}
            {w && w.kind === 'reply' && <div className="ksim-choices"><button type="button" className="ghost" onClick={() => act((s) => choose(s, 'timeout'))}>Não responder ({w.timeout ? `${w.timeout} min` : 'tempo esgotado'})</button></div>}
            {w && w.kind === 'agent' && <div className="ksim-choices">{[['done', 'Concluiu'], ['handoff', 'Pediu humano'], ['expiration', 'Sem resposta'], ['error', 'Erro']].map(([id, l]) => <button key={id} type="button" onClick={() => act((s) => choose(s, id))}>{l}</button>)}</div>}
            {caught && st.done && <div className="ksim-choices"><button type="button" onClick={begin}><Icon name="rotate-ccw" size={13} /> Testar de novo</button></div>}
          </>
        )}
      </div>
      <div className="ksim-ft">
        {started && (
          <div className="ksim-vars">
            <button type="button" onClick={() => setVarsOpen((v) => !v)} aria-expanded={varsOpen}><Icon name="braces" size={14} />Variáveis do contato <em>{vars.length}</em><span style={{ flex: 1 }} /><Icon name={varsOpen ? 'chevron-up' : 'chevron-down'} size={15} /></button>
            {varsOpen && <dl>{vars.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v.slice(0, 160)}</dd></React.Fragment>)}</dl>}
          </div>
        )}
        <div className="ksim-in">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} disabled={!canType}
            placeholder={!started ? 'Inicie o teste para conversar' : canType ? 'Responder como Maria Silva' : st && st.done && caught ? 'Fim do fluxo' : w && w.kind === 'choose' ? 'Escolha uma opção acima' : 'Aguardando o fluxo…'} />
          <button type="button" className="ksim-send" aria-label="Enviar" disabled={!canType || !text.trim()} onClick={send}><Icon name="send-horizontal" size={17} /></button>
        </div>
      </div>
    </div>
  );
}
