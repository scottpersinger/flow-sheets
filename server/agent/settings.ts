// Per-user assistant settings: whether the live assistant runs on the server's model or on an OpenAI model
// with the user's own API key. The key is stored encrypted (the same server key as connector credentials)
// and only ever returned masked.
import { DEFAULT_OPENAI_MODEL, OPENAI_MODELS, type AssistantSettings, type AssistantSettingsUpdate, type OpenAIModelId } from '../../shared/agent/protocol.ts';
import { decrypt, encrypt, loadKey, mask } from '../connectors/secrets.ts';
import type { DB } from '../db.ts';

interface Row {
  provider: string;
  openai_model: string;
  openai_key: string | null;
  openai_key_masked: string | null;
}

export class SettingsError extends Error {}

const isModel = (v: unknown): v is OpenAIModelId => OPENAI_MODELS.some((m) => m.id === v);

export class AssistantSettingsStore {
  private db: DB;
  private key: Buffer;

  constructor(db: DB, keyFile: string) {
    this.db = db;
    this.key = loadKey(keyFile);
  }

  private row(userId: string): Row | undefined {
    return this.db.prepare('SELECT provider, openai_model, openai_key, openai_key_masked FROM assistant_settings WHERE user_id = ?').get(userId) as Row | undefined;
  }

  get(userId: string): AssistantSettings {
    const row = this.row(userId);
    return {
      provider: row?.provider === 'openai' && row.openai_key ? 'openai' : 'default',
      openaiModel: isModel(row?.openai_model) ? row.openai_model : DEFAULT_OPENAI_MODEL,
      openaiKey: row?.openai_key ? (row.openai_key_masked ?? '••••') : null,
    };
  }

  /** The key and model to run the user's assistant on, or null when they use the server's model. */
  openai(userId: string): { apiKey: string; model: OpenAIModelId } | null {
    const row = this.row(userId);
    if (row?.provider !== 'openai' || !row.openai_key) return null;
    return { apiKey: decrypt(this.key, row.openai_key).api_key, model: isModel(row.openai_model) ? row.openai_model : DEFAULT_OPENAI_MODEL };
  }

  /**
   * Validate and save. `check` is called with the key that will be in effect when the provider is OpenAI,
   * so a wrong key or a model the key cannot use is reported here rather than in the chat.
   */
  async update(userId: string, body: Partial<AssistantSettingsUpdate>, check: (apiKey: string, model: OpenAIModelId) => Promise<void>): Promise<AssistantSettings> {
    if (body.provider !== 'default' && body.provider !== 'openai') throw new SettingsError('Choose what the assistant runs on.');
    if (!isModel(body.openaiModel)) throw new SettingsError('Choose one of the listed models.');
    const row = this.row(userId);
    let stored = row?.openai_key ?? null;
    let masked = row?.openai_key_masked ?? null;
    let apiKey = stored ? decrypt(this.key, stored).api_key : null;
    if (body.openaiKey === null) {
      stored = masked = apiKey = null;
    } else if (body.openaiKey !== undefined) {
      if (typeof body.openaiKey !== 'string') throw new SettingsError('The API key is not valid.');
      const entered = body.openaiKey.trim();
      if (entered) {
        if (entered.length > 400 || /\s/.test(entered)) throw new SettingsError('The API key is not valid.');
        apiKey = entered;
        stored = encrypt(this.key, { api_key: entered });
        masked = mask(entered);
      }
    }
    if (body.provider === 'openai') {
      if (!apiKey) throw new SettingsError('Enter your OpenAI API key to use an OpenAI model.');
      await check(apiKey, body.openaiModel);
    }
    this.db
      .prepare(
        `INSERT INTO assistant_settings (user_id, provider, openai_model, openai_key, openai_key_masked, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, openai_model = excluded.openai_model, openai_key = excluded.openai_key,
           openai_key_masked = excluded.openai_key_masked, updated_at = excluded.updated_at`,
      )
      .run(userId, body.provider, body.openaiModel, stored, masked, new Date().toISOString());
    return this.get(userId);
  }
}
