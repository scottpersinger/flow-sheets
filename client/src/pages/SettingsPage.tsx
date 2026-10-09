// Settings: what the assistant runs on. By default that is the server's model; a user can instead enter their
// own OpenAI API key and pick a model. The key goes to the server and is never shown again.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { OPENAI_MODELS, type AssistantSettings, type OpenAIModelId } from '../../../shared/agent/protocol.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { api } from '../api.ts';
import { Account } from '../components/Account.tsx';

export function SettingsPage() {
  const [saved, setSaved] = useState<AssistantSettings | null>(null);
  const [provider, setProvider] = useState<AssistantSettings['provider']>('default');
  const [model, setModel] = useState<OpenAIModelId>(OPENAI_MODELS[0].id);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (s: AssistantSettings) => {
    setSaved(s);
    setProvider(s.provider);
    setModel(s.openaiModel);
    setKey('');
  };

  useEffect(() => {
    api
      .assistantSettings()
      .then((res) => show(res.settings))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async (body: Parameters<typeof api.saveAssistantSettings>[0], done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      show((await api.saveAssistantSettings(body)).settings);
      setNotice(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const modelHint = OPENAI_MODELS.find((m) => m.id === model)?.hint;

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-brand">
          <Link to="/" className="home-back">
            ‹ FreeFlow Docs
          </Link>
          <span>Settings</span>
        </div>
        <div className="home-user">
          <AgentButton />
          <Account />
        </div>
      </header>

      <section className="home-inner changes">
        <h2>Assistant</h2>
        <p className="changes-intro">
          The assistant runs on the built-in model unless you choose an OpenAI model here. OpenAI usage is billed to your own API key, which is stored encrypted
          on the server and never shown again.
        </p>
        {saved === null ? (
          !error && <div className="page-loading">Loading…</div>
        ) : (
          <form
            className="settings-form"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ provider, openaiModel: model, ...(key.trim() ? { openaiKey: key.trim() } : {}) }, 'Saved.');
            }}
          >
            <label className="field">
              <span>The assistant runs on</span>
              <select value={provider} onChange={(e) => setProvider(e.target.value as AssistantSettings['provider'])}>
                <option value="default">Built-in model</option>
                <option value="openai">OpenAI, with my API key</option>
              </select>
            </label>
            {provider === 'openai' && (
              <>
                <label className="field">
                  <span>OpenAI API key</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={key}
                    placeholder={saved.openaiKey ? `Saved (${saved.openaiKey}); leave blank to keep` : 'sk-…'}
                    onChange={(e) => setKey(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Model</span>
                  <select value={model} onChange={(e) => setModel(e.target.value as OpenAIModelId)}>
                    {OPENAI_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  {modelHint && <span className="field-hint">{modelHint}</span>}
                </label>
              </>
            )}
            {error && <div className="form-error">{error}</div>}
            {notice && <div className="connector-notice">{notice}</div>}
            <div className="settings-actions">
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? 'Checking…' : 'Save'}
              </button>
              {saved.openaiKey && (
                <button type="button" className="btn danger" disabled={busy} onClick={() => void save({ provider: 'default', openaiModel: model, openaiKey: null }, 'The key was removed.')}>
                  Remove saved key
                </button>
              )}
            </div>
          </form>
        )}
        {saved === null && error && <div className="form-error">{error}</div>}
      </section>
    </div>
  );
}
