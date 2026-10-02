import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatItem } from '../../../shared/agent/protocol.ts';
import { MOD } from '../commands.ts';
import { useAgent } from './AgentProvider.tsx';
import { targetOf } from './clientTools.ts';
import { toolLabel } from './describe.ts';

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

const SHEET_SUGGESTIONS = ['Summarize what’s in this spreadsheet', 'Add a totals row under the data', 'Make the header row bold and freeze it'];
const HOME_SUGGESTIONS = ['Which spreadsheets did I edit most recently?', 'Create a spreadsheet to track monthly expenses'];

export function AgentButton() {
  const { open, setOpen } = useAgent();
  return (
    <button className={`btn agent-toggle${open ? ' active' : ''}`} onClick={() => setOpen(!open)} title={`Assistant (${MOD}K)`}>
      <SparkIcon />
      Assistant
    </button>
  );
}

export function AgentPanel() {
  const agent = useAgent();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const onSheet = !!agent.sheet;

  useEffect(() => inputRef.current?.focus(), []);

  // Keep the newest message in view while the reply streams in.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.items, agent.confirm, agent.error, agent.running]);

  // Grow the input with its text, up to a limit.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const submit = (text: string) => {
    if (!text.trim() || agent.running) return;
    agent.send(text);
    setDraft('');
  };

  const last = agent.items[agent.items.length - 1];
  const thinking = agent.running && !agent.confirm && last?.kind !== 'assistant';

  return (
    <aside className="agent-panel" aria-label="Assistant">
      <div className="agent-head">
        <SparkIcon />
        <span className="agent-title">Assistant</span>
        <button className="link agent-new" onClick={() => void agent.reset()} disabled={agent.running || !agent.items.length} title="Start a new conversation">
          New chat
        </button>
        <button className="agent-close" onClick={() => agent.setOpen(false)} aria-label="Close assistant" title={`Close (${MOD}K)`}>
          ×
        </button>
      </div>

      <div className="agent-list" ref={listRef}>
        {agent.items.length === 0 && (
          <div className="agent-empty">
            <p>Ask me to read, edit or format {onSheet ? 'this spreadsheet' : 'your spreadsheets'}, or to find and open another one.</p>
            {(onSheet ? SHEET_SUGGESTIONS : HOME_SUGGESTIONS).map((s) => (
              <button key={s} className="agent-suggestion" onClick={() => submit(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {agent.items.map((it, i) =>
          it.kind === 'user' ? (
            <div key={i} className="agent-msg user">
              {it.text}
            </div>
          ) : it.kind === 'assistant' ? (
            <div key={i} className="agent-msg assistant">
              {it.text.trim()}
            </div>
          ) : (
            <ToolRow key={it.id} item={it} />
          ),
        )}
        {agent.confirm && (
          <div className="agent-confirm" role="alertdialog">
            <div>{agent.confirm.question}</div>
            <div className="agent-confirm-actions">
              <button className="btn" onClick={() => agent.confirm?.answer(false)}>
                Don’t allow
              </button>
              <button className="btn danger" onClick={() => agent.confirm?.answer(true)}>
                Allow
              </button>
            </div>
          </div>
        )}
        {thinking && (
          <div className="agent-working" aria-live="polite">
            <span />
            <span />
            <span />
          </div>
        )}
        {agent.error && <div className="agent-error">{agent.error}</div>}
      </div>

      <form
        className="agent-compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder={onSheet ? 'Ask about this spreadsheet…' : 'Ask about your spreadsheets…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(draft);
            }
            if (e.key === 'Escape') agent.setOpen(false);
          }}
        />
        {agent.running ? (
          <button type="button" className="btn agent-send" onClick={agent.stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn primary agent-send" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>
    </aside>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const agent = useAgent();
  const sheet = agent.sheet;
  const target = sheet && item.status === 'ok' ? targetOf(item, sheet.ctl) : null;
  const label = toolLabel(item.name, item.input);
  const reveal = () => {
    if (!sheet || !target) return;
    if (sheet.ctl.activeTabId !== target.tabId) sheet.ctl.switchTab(target.tabId);
    sheet.ctl.selectRange(target.range);
  };
  return (
    <div className={`agent-tool ${item.status}`} title={item.error}>
      <span className="agent-tool-icon" aria-hidden="true">
        {item.status === 'running' ? <span className="agent-spinner" /> : item.status === 'ok' ? '✓' : '!'}
      </span>
      {target ? (
        <button className="link agent-tool-label" onClick={reveal} title="Show in the spreadsheet">
          {label}
        </button>
      ) : (
        <span className="agent-tool-label">{label}</span>
      )}
      {item.status === 'error' && <span className="agent-tool-error">{failureLabel(item.error)}</span>}
    </div>
  );
}

/** Short reason for a tool call that didn't succeed (the full message is in the tooltip). */
function failureLabel(error: string | undefined): string {
  if (error?.startsWith('The user declined')) return 'Declined';
  if (error === 'Stopped' || error?.includes('interrupted')) return 'Stopped';
  return 'Failed';
}

function SparkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5l1.6 4.2 4.4 1.6-4.4 1.6L8 13.1 6.4 8.9 2 7.3l4.4-1.6z" fill="currentColor" />
      <path d="M13 11l.6 1.4 1.4.6-1.4.6L13 15l-.6-1.4L11 13l1.4-.6z" fill="currentColor" opacity=".7" />
    </svg>
  );
}
