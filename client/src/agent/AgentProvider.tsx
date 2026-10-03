// Agent chat state for the whole app. Lives above the routes, so the conversation (and a turn in
// progress) survives navigation such as the agent opening another spreadsheet.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { rangeToString } from '../../../shared/cellref.ts';
import { JOB_ACTIVE_STATUSES, type AgentContext, type AgentJob, type AgentTurnRequest, type ChatItem, type ClientToolCall, type ClientToolResult } from '../../../shared/agent/protocol.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { isMac } from '../commands.ts';
import type { SheetController } from '../state/controller.ts';
import { confirmationFor, runClientTool, ToolError } from './clientTools.ts';

export interface OpenSheet {
  ctl: SheetController;
  meta: SheetMeta;
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

interface AgentState {
  open: boolean;
  setOpen(open: boolean): void;
  items: ChatItem[];
  running: boolean;
  error: string | null;
  /** A destructive action waiting for the user's answer. */
  confirm: { question: string; answer(ok: boolean): void } | null;
  send(text: string): void;
  stop(): void;
  reset(): Promise<void>;
  /** The spreadsheet page reports the open spreadsheet (null when it closes). */
  setOpenSheet(sheet: OpenSheet | null): void;
  /** The spreadsheet page reports that a spreadsheet failed to load. */
  sheetFailed(id: string, message: string): void;
  /** The open spreadsheet, or null on other pages. */
  sheet: OpenSheet | null;
  /** The latest change to the app's own code, while it runs or until its outcome has been seen. */
  job: AgentJob | null;
  /** Hide a finished job's card. */
  dismissJob(): void;
}

const AgentCtx = createContext<AgentState | null>(null);

const OPEN_KEY = 'agent-panel-open';
const OPEN_TIMEOUT_MS = 20_000;
const JOB_POLL_MS = 2000;

/** The message that resumes the conversation once an app change is live. */
function jobLiveMessage(job: AgentJob): string {
  return `The app change "${job.title}" is live. The coding agent says: ${job.summary ?? 'The change was made.'}\n\nContinue with what I asked for before.`;
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function AgentProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpenState] = useState(readOpen);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AgentState['confirm']>(null);
  const sheetRef = useRef<OpenSheet | null>(null);
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const waiters = useRef(new Map<string, { resolve(ctl: SheetController): void; reject(e: Error): void }>());
  const [job, setJob] = useState<AgentJob | null>(null);
  const sendRef = useRef<(text: string) => void>(() => {});

  const setOpen = useCallback((o: boolean) => {
    setOpenState(o);
    try {
      localStorage.setItem(OPEN_KEY, o ? '1' : '0');
    } catch {
      // Storage unavailable; the panel just won't remember its state.
    }
  }, []);

  // Load the conversation when someone signs in; clear it when they sign out. Then pick up the latest app
  // change: if one finished while we were away (the app restarts when it lands), tell the assistant.
  useEffect(() => {
    abortRef.current?.abort();
    setItems([]);
    setError(null);
    setJob(null);
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.agentTranscript();
        if (cancelled) return;
        // Don't overwrite a message sent before the saved transcript arrived.
        setItems((prev) => (prev.length ? prev : r.items));
        const { job } = await api.latestJob();
        if (cancelled || !job) return;
        if (job.status === 'done' && !job.acknowledged) {
          // Acknowledge before exposing the job, or the reload effect below would reload again.
          await api.acknowledgeJob(job.id);
          if (cancelled) return;
          setJob({ ...job, acknowledged: true });
          // Right after the reload the spreadsheet page may still be loading; give it a moment so the
          // assistant's context says which spreadsheet is open.
          if (location.pathname.startsWith('/s/')) {
            for (let i = 0; i < 100 && !sheetRef.current && !cancelled; i++) await new Promise((r) => setTimeout(r, 100));
          }
          if (cancelled) return;
          sendRef.current(jobLiveMessage(job));
        } else {
          setJob(job);
        }
      } catch {
        // Not signed in any more, or the server is restarting; the panel just starts empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // While a job runs, poll it. When it lands, the app's code has changed under us: reload to pick up the
  // new client, and the effect above then resumes the conversation. Wait for any reply in progress first.
  useEffect(() => {
    if (!job || !JOB_ACTIVE_STATUSES.has(job.status)) return;
    const timer = setInterval(async () => {
      try {
        const { job: next } = await api.latestJob();
        if (next && next.id === job.id) setJob(next);
      } catch {
        // The dev server restarts as files change; try again next tick.
      }
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [job]);

  useEffect(() => {
    if (job?.status === 'done' && !job.acknowledged && !running) location.reload();
  }, [job, running]);

  const dismissJob = useCallback(() => {
    if (!job) return;
    void api.acknowledgeJob(job.id).catch(() => {});
    setJob({ ...job, acknowledged: true });
  }, [job]);

  // ⌘K / Ctrl+K toggles the panel.
  useEffect(() => {
    if (!user) return;
    const onKey = (e: KeyboardEvent) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [user, open, setOpen]);

  const setOpenSheet = useCallback((sheet: OpenSheet | null) => {
    sheetRef.current = sheet;
    setSheet(sheet);
    const w = sheet && waiters.current.get(sheet.meta.id);
    if (w) {
      waiters.current.delete(sheet.meta.id);
      w.resolve(sheet.ctl);
    }
  }, []);

  const sheetFailed = useCallback((id: string, message: string) => {
    const w = waiters.current.get(id);
    if (w) {
      waiters.current.delete(id);
      w.reject(new ToolError(message));
    }
  }, []);

  const context = (): AgentContext => {
    const s = sheetRef.current;
    if (!s) return { page: 'home' };
    return {
      page: 'sheet',
      sheetId: s.meta.id,
      title: s.meta.title,
      ...(s.meta.branch ? { branchOf: s.meta.branch.parentTitle } : {}),
      tabs: s.ctl.store.workbook.tabs.map((t) => t.name),
      activeTab: s.ctl.tab.name,
      selection: s.ctl.sel.ranges.map(rangeToString),
    };
  };

  const openSheetById = async (id: string): Promise<SheetController> => {
    const cur = sheetRef.current;
    if (cur?.meta.id === id) return cur.ctl;
    if (cur) {
      if (cur.ctl.edit) cur.ctl.commitEdit();
      await cur.ctl.saver.flush();
    }
    const loaded = new Promise<SheetController>((resolve, reject) => {
      waiters.current.set(id, { resolve, reject });
      setTimeout(() => {
        if (waiters.current.delete(id)) reject(new ToolError('The spreadsheet did not open in time.'));
      }, OPEN_TIMEOUT_MS);
    });
    navigate(`/s/${encodeURIComponent(id)}`);
    return loaded;
  };

  const requestAppChange = async (title: string, spec: string): Promise<{ id: string }> => {
    try {
      const { job } = await api.createJob(title, spec);
      setJob(job);
      return { id: job.id };
    } catch (e) {
      throw new ToolError(e instanceof ApiError ? e.message : 'The change could not be queued.');
    }
  };

  const updateTool = (id: string, patch: Partial<ToolItem>) =>
    setItems((prev) => prev.map((it) => (it.kind === 'tool' && it.id === id ? { ...it, ...patch } : it)));

  const appendText = (text: string) =>
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === 'assistant') return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      return [...prev, { kind: 'assistant', text }];
    });

  const ask = (question: string) =>
    new Promise<boolean>((resolve) => {
      setConfirm({
        question,
        answer: (ok) => {
          setConfirm(null);
          resolve(ok);
        },
      });
    });

  const runClientCalls = async (calls: ClientToolCall[], group: string, signal: AbortSignal): Promise<ClientToolResult[]> => {
    const results: ClientToolResult[] = [];
    for (const call of calls) {
      if (signal.aborted) break;
      setItems((prev) => [...prev, { kind: 'tool', id: call.id, name: call.name, input: call.input, status: 'running' }]);
      const question = confirmationFor(call, sheetRef.current?.ctl ?? null);
      if (question && !(await ask(question))) {
        const declined = 'The user declined this action.';
        results.push({ id: call.id, content: declined, isError: true });
        updateTool(call.id, { status: 'error', error: declined });
        continue;
      }
      if (signal.aborted) break;
      try {
        const content = await runClientTool(call, { ctl: sheetRef.current?.ctl ?? null, group, openSheet: openSheetById, requestAppChange, uploadImage: api.uploadImage });
        results.push({ id: call.id, content });
        updateTool(call.id, { status: 'ok' });
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `The tool failed: ${e instanceof Error ? e.message : String(e)}`;
        if (!(e instanceof ToolError)) console.error(e);
        results.push({ id: call.id, content: message, isError: true });
        updateTool(call.id, { status: 'error', error: message });
      }
    }
    return results;
  };

  const send = (text: string) => {
    const message = text.trim();
    if (!message || running) return;
    const abort = new AbortController();
    abortRef.current = abort;
    // Everything the agent changes for this message undoes as one step.
    const group = `agent-${Date.now()}`;
    setItems((prev) => [...prev, { kind: 'user', text: message }]);
    setError(null);
    setRunning(true);

    void (async () => {
      let req: AgentTurnRequest = { message, context: context() };
      try {
        for (;;) {
          let calls: ClientToolCall[] | null = null;
          const turn = () =>
            api.agentTurn(req, abort.signal, (e) => {
              if (e.type === 'text') appendText(e.text);
              else if (e.type === 'tool_start') setItems((prev) => [...prev, { kind: 'tool', id: e.id, name: e.name, input: e.input, status: 'running' }]);
              else if (e.type === 'tool_end') updateTool(e.id, { status: e.ok ? 'ok' : 'error' });
              else if (e.type === 'client_tools') calls = e.calls;
              else if (e.type === 'error') setError(e.message);
            });
          try {
            await turn();
          } catch (e) {
            // Right after Stop the server may still be winding down the previous turn; retry once.
            if (!(e instanceof ApiError && e.status === 409)) throw e;
            await new Promise((r) => setTimeout(r, 1000));
            await turn();
          }
          if (!calls || abort.signal.aborted) break;
          const toolResults = await runClientCalls(calls, group, abort.signal);
          if (abort.signal.aborted) break;
          req = { context: context(), toolResults };
        }
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (abortRef.current === abort) {
          abortRef.current = null;
          setRunning(false);
          // Calls cut off by Stop never finish.
          setItems((prev) => prev.map((it) => (it.kind === 'tool' && it.status === 'running' ? { ...it, status: 'error', error: 'Stopped' } : it)));
        }
      }
    })();
  };

  sendRef.current = send;

  const stop = () => {
    abortRef.current?.abort();
    confirm?.answer(false);
  };

  const reset = async () => {
    if (running) return;
    await api.agentReset();
    setItems([]);
    setError(null);
  };

  const value: AgentState = {
    open,
    setOpen,
    items,
    running,
    error,
    confirm,
    send,
    stop,
    reset,
    setOpenSheet,
    sheetFailed,
    sheet,
    job,
    dismissJob,
  };
  return <AgentCtx.Provider value={value}>{children}</AgentCtx.Provider>;
}

export function useAgent(): AgentState {
  const ctx = useContext(AgentCtx);
  if (!ctx) throw new Error('useAgent must be used inside AgentProvider');
  return ctx;
}

/** Report the open spreadsheet to the agent while a spreadsheet page is mounted. */
export function useRegisterSheet(ctl: SheetController, meta: SheetMeta): void {
  const { setOpenSheet } = useAgent();
  const sheet = useMemo(() => ({ ctl, meta }), [ctl, meta]);
  useEffect(() => {
    setOpenSheet(sheet);
    return () => setOpenSheet(null);
  }, [sheet, setOpenSheet]);
}
