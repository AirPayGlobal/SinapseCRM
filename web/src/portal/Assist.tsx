import { useEffect, useRef, useState } from 'react';
import { portalApi, publicApi } from '../api';

interface Turn { role: 'me' | 'bot'; text: string; action?: any; suggestions?: string[] }

/**
 * Sinapse Assist chat. In the portal it acts for the signed-in customer; on the website it answers
 * from approved knowledge only and asks for an email address before it will open a case.
 */
export default function AssistChat({ mode, compact }: { mode: 'portal' | 'website'; compact?: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([{ role: 'bot', text: mode === 'portal'
    ? 'Hello, I am Sinapse Assist. I can answer questions from Namport\'s approved guidance, check the status of your cases, log a new query or pass you to a person.'
    : 'Hello, I am Sinapse Assist for the Namibian Ports Authority. Ask me a question — I answer from Namport\'s approved guidance and will tell you if I don\'t know.' }]);
  const [session, setSession] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [visitor, setVisitor] = useState({ name: '', email: '' });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { void end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns]);
  const client = mode === 'portal' ? portalApi : publicApi;

  const send = async (msg: string) => {
    if (!msg.trim() || busy) return;
    setTurns((t) => [...t, { role: 'me', text: msg }]);
    setText('');
    setBusy(true);
    try {
      const r = await client.post('/portal/assist', { session_id: session, message: msg, visitor: mode === 'website' && visitor.email ? visitor : undefined });
      setSession(r.session_id);
      setTurns((t) => [...t, { role: 'bot', text: r.reply, action: r.action, suggestions: r.suggestions }]);
    } catch (e) {
      setTurns((t) => [...t, { role: 'bot', text: `Sorry — ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };
  const last = turns[turns.length - 1];
  return (
    <div className="stack" style={{ display: 'flex', flexDirection: 'column', height: compact ? '100%' : undefined }}>
      <div className="chat" aria-live="polite" style={{ flex: 1, overflowY: 'auto', maxHeight: compact ? undefined : 460, minHeight: 200 }}>
        {turns.map((t, i) => {
          const [body, source] = t.text.split('\n\nSource: ');
          return (
            <div key={i} className={`bubble ${t.role}`}>
              {body}
              {source && <div className="src">Source: {source}</div>}
              {t.action?.reference && <div className="src">Reference <b>{t.action.reference}</b>{mode === 'portal' && <> · <a href={`/portal/queries/${t.action.reference}`}>open</a></>}</div>}
            </div>
          );
        })}
        {busy && <div className="bubble bot muted">…</div>}
        <div ref={end} />
      </div>
      {last.role === 'bot' && last.suggestions?.length ? (
        <div className="row">{last.suggestions.map((s) => <button key={s} className="btn sm" onClick={() => {
          if (s === 'That answered my question' && session) { void publicApi.post(`/portal/assist/${session}/feedback`, { helpful: true }); setTurns((t) => [...t, { role: 'bot', text: 'Glad that helped.' }]); }
          else void send(s === 'Yes, open a case' ? 'yes' : s === 'I still need help' ? 'I want to speak to a person' : s);
        }}>{s}</button>)}</div>
      ) : null}
      {mode === 'website' && (
        <details className="small">
          <summary>Want a reply by email? Add your details</summary>
          <div className="row" style={{ marginTop: 6 }}>
            <input placeholder="Name" value={visitor.name} onChange={(e) => setVisitor({ ...visitor, name: e.target.value })} style={{ flex: 1 }} />
            <input placeholder="Email" type="email" value={visitor.email} onChange={(e) => setVisitor({ ...visitor, email: e.target.value })} style={{ flex: 1 }} />
          </div>
        </details>
      )}
      <form className="pill-input" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input aria-label="Message Sinapse Assist" placeholder="Ask a question or quote a reference…" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary" disabled={busy || !text.trim()}>Send</button>
      </form>
      <div className="small muted">Assist won't quote tariffs, commit to dates or interpret contracts — those go to a person.</div>
    </div>
  );
}
