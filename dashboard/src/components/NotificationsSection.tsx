import { useEffect, useState, useCallback, useRef } from 'react';
import {
  type NotificationChannel,
  type ChannelType,
  fetchNotificationChannels,
  createNotificationChannel,
  updateNotificationChannel,
  deleteNotificationChannel,
  testNotificationChannel,
} from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { AlertRulesPanel } from './AlertRulesPanel';
import { AlertHistoryPanel } from './AlertHistoryPanel';
import { SilencesPanel } from './SilencesPanel';
import { ScheduledReportsPanel } from './ScheduledReportsPanel';

interface NotificationsSectionProps {
  onAuthError: () => void;
}

type NotifSubTab = 'channels' | 'rules' | 'history' | 'silences' | 'reports';

// ── Channel type metadata ────────────────────────────────────

const CHANNEL_TYPES: { value: ChannelType; label: string; description: string }[] = [
  { value: 'ntfy', label: 'NTfy', description: 'NTfy push notifications (ntfy.sh or self-hosted)' },
  { value: 'telegram', label: 'Telegram', description: 'Telegram Bot messages' },
  { value: 'webhook', label: 'Webhook', description: 'Generic HTTP POST webhook' },
  { value: 'gotify', label: 'Gotify', description: 'Gotify server notifications' },
  { value: 'pushover', label: 'Pushover', description: 'Pushover push notifications' },
];

// Field definitions for each channel type config
interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  type: 'text' | 'password' | 'url';
  hint?: string;
}

const CHANNEL_FIELDS: Record<ChannelType, FieldDef[]> = {
  webhook: [
    { key: 'url', label: 'Webhook URL', placeholder: 'https://example.com/webhook', required: true, type: 'url' },
  ],
  ntfy: [
    { key: 'base_url', label: 'Server URL', placeholder: 'https://ntfy.sh', required: false, type: 'url', hint: 'Leave empty for public ntfy.sh' },
    { key: 'topic', label: 'Topic', placeholder: 'my-alerts', required: true, type: 'text' },
    { key: 'auth_header_ref', label: 'Auth Header', placeholder: 'Bearer tk_...  or  env:NTFY_TOKEN', required: false, type: 'password', hint: 'Bearer token or env: reference' },
  ],
  pushover: [
    { key: 'token_ref', label: 'App Token', placeholder: 'env:PUSHOVER_TOKEN', required: true, type: 'password', hint: 'Pushover app token or env: reference' },
    { key: 'user_key', label: 'User Key', placeholder: 'env:PUSHOVER_USER_KEY', required: true, type: 'password', hint: 'Pushover user key or env: reference' },
  ],
  gotify: [
    { key: 'base_url', label: 'Gotify URL', placeholder: 'https://gotify.example.com', required: true, type: 'url' },
    { key: 'token_ref', label: 'App Token', placeholder: 'env:GOTIFY_APP_TOKEN', required: true, type: 'password', hint: 'Gotify app token or env: reference' },
  ],
  telegram: [
    { key: 'token_ref', label: 'Bot Token', placeholder: '1234567890:AABBccdd-EEffGGhhIIjj', required: true, type: 'password', hint: 'Bot token from @BotFather (format: 1234567890:AAxx...)' },
    { key: 'chat_id', label: 'Chat ID', placeholder: '123456789', required: true, type: 'text', hint: 'Numeric chat/group ID (see setup guide below)' },
  ],
};

/** Per-type setup instructions shown inside the channel form modal. */
const CHANNEL_SETUP_GUIDES: Partial<Record<ChannelType, { title: string; steps: string[] }>> = {
  telegram: {
    title: 'Telegram Setup Guide',
    steps: [
      '1. Open Telegram and search for @BotFather.',
      '2. Send /newbot and follow the prompts to create a bot.',
      '3. Copy the Bot Token (looks like 1234567890:AABBccdd-EEff...) and paste it in the "Bot Token" field above.',
      '4. To get your Chat ID: search for @userinfobot on Telegram, send /start, and it will reply with your numeric ID.',
      '5. For a group chat: add the bot to the group, send a message, then open https://api.telegram.org/bot<TOKEN>/getUpdates in a browser. Look for "chat":{"id":-100...} — that negative number is the Chat ID.',
      '6. Important: you must start a conversation with the bot first (/start) before it can send you messages.',
    ],
  },
  ntfy: {
    title: 'NTfy Setup Guide',
    steps: [
      '1. Install the ntfy app on your phone (Android/iOS) or use the web UI at ntfy.sh.',
      '2. Subscribe to a topic (e.g., "my-syslog-alerts").',
      '3. Enter the topic name in the "Topic" field above.',
      '4. For self-hosted ntfy, set the Server URL. Leave it empty to use the public ntfy.sh.',
    ],
  },
  pushover: {
    title: 'Pushover Setup Guide',
    steps: [
      '1. Sign up at pushover.net and install the Pushover app.',
      '2. Create an application in the Pushover dashboard to get an App Token.',
      '3. Find your User Key on the Pushover dashboard main page.',
      '4. Enter both values above. Use env:VAR_NAME to reference Docker environment variables.',
    ],
  },
  gotify: {
    title: 'Gotify Setup Guide',
    steps: [
      '1. Set up a Gotify server (self-hosted).',
      '2. Create an Application in the Gotify web UI and copy the App Token.',
      '3. Enter the Gotify server URL and the App Token above.',
    ],
  },
  webhook: {
    title: 'Webhook Setup',
    steps: [
      '1. Enter the URL that will receive POST requests with a JSON alert payload.',
      '2. The payload includes: title, body, severity, variant (firing/resolved), system_name, criterion.',
    ],
  },
};

// ── Component ────────────────────────────────────────────────

type Modal =
  | { kind: 'create' }
  | { kind: 'edit'; channel: NotificationChannel }
  | { kind: 'delete'; channel: NotificationChannel }
  | null;

export function NotificationsSection({ onAuthError }: NotificationsSectionProps) {
  const [subTab, setSubTab] = useState<NotifSubTab>('rules');
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await fetchNotificationChannels();
      setChannels(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => { load(); }, [load]);

  // ── Test notification ─────────────────────────────────
  const handleTest = async (id: string) => {
    setTesting(id);
    setError('');
    setSuccess('');
    try {
      const result = await testNotificationChannel(id);
      setSuccess(result.message || 'Test notification sent successfully.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(`Test failed: ${msg}`);
    } finally {
      setTesting(null);
    }
  };

  // ── Toggle enabled ────────────────────────────────────
  const handleToggle = async (channel: NotificationChannel) => {
    try {
      const updated = await updateNotificationChannel(channel.id, { enabled: !channel.enabled });
      setChannels((prev) => prev.map((c) => (c.id === channel.id ? updated : c)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    }
  };

  // ── Create/Update ─────────────────────────────────────
  const handleSaveChannel = async (
    type: ChannelType,
    name: string,
    config: Record<string, unknown>,
    existingId?: string,
  ) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      if (existingId) {
        const updated = await updateNotificationChannel(existingId, { name, config });
        setChannels((prev) => prev.map((c) => (c.id === existingId ? updated : c)));
        setSuccess('Channel updated.');
      } else {
        const created = await createNotificationChannel({ type, name, config });
        setChannels((prev) => [...prev, created]);
        setSuccess('Channel created.');
      }
      setModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await deleteNotificationChannel(id);
      setChannels((prev) => prev.filter((c) => c.id !== id));
      setModal(null);
      setSuccess('Channel deleted.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const channelTypeName = (type: string) => {
    return CHANNEL_TYPES.find((t) => t.value === type)?.label ?? type;
  };

  // ── Render ────────────────────────────────────────────
  return (
    <div className="notif-section">
      {/* ── Sub-pills navigation ── */}
      <div className="notif-pills" role="tablist" aria-label="Notification sections">
        <button
          className={`notif-pill${subTab === 'rules' ? ' active' : ''}`}
          onClick={() => setSubTab('rules')}
          role="tab"
          aria-selected={subTab === 'rules'}
        >
          Alert Rules
        </button>
        <button
          className={`notif-pill${subTab === 'channels' ? ' active' : ''}`}
          onClick={() => setSubTab('channels')}
          role="tab"
          aria-selected={subTab === 'channels'}
        >
          Channels
        </button>
        <button
          className={`notif-pill${subTab === 'history' ? ' active' : ''}`}
          onClick={() => setSubTab('history')}
          role="tab"
          aria-selected={subTab === 'history'}
        >
          History
        </button>
        <button
          className={`notif-pill${subTab === 'silences' ? ' active' : ''}`}
          onClick={() => setSubTab('silences')}
          role="tab"
          aria-selected={subTab === 'silences'}
        >
          Silences
        </button>
        <button
          className={`notif-pill${subTab === 'reports' ? ' active' : ''}`}
          onClick={() => setSubTab('reports')}
          role="tab"
          aria-selected={subTab === 'reports'}
        >
          Scheduled Reports
        </button>
      </div>

      {/* ── Sub-tab content ── */}
      {subTab === 'rules' ? (
        <AlertRulesPanel onAuthError={onAuthError} />
      ) : subTab === 'history' ? (
        <AlertHistoryPanel onAuthError={onAuthError} />
      ) : subTab === 'silences' ? (
        <SilencesPanel onAuthError={onAuthError} />
      ) : subTab === 'reports' ? (
        <ScheduledReportsPanel onAuthError={onAuthError} />
      ) : (
      /* ── Channels panel (inline, existing code) ── */
      <>
      <div className="notif-header">
        <div>
          <h3>Notification Channels</h3>
          <p className="notif-desc">
            Configure where alert notifications are sent. Create channels, then set up notification rules to trigger them.
          </p>
        </div>
        <button className="btn btn-sm" onClick={() => setModal({ kind: 'create' })}>
          + Add Channel
        </button>
      </div>

      {error && (
        <div className="error-msg" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss error">&times;</button>
        </div>
      )}
      {success && (
        <div className="success-msg" role="status">
          {success}
          <button className="error-dismiss" onClick={() => setSuccess('')} aria-label="Dismiss">&times;</button>
        </div>
      )}

      {loading ? (
        <div className="settings-loading"><div className="spinner" /> Loading channels…</div>
      ) : channels.length === 0 ? (
        <div className="notif-empty">
          <div className="notif-empty-icon" aria-hidden="true">&#128276;</div>
          <h4>No notification channels</h4>
          <p>
            Create a notification channel to start receiving alerts when scores exceed thresholds.
            Supported: NTfy, Telegram, Webhook, Gotify, Pushover.
          </p>
        </div>
      ) : (
        <div className="notif-channel-list">
          {channels.map((ch) => (
            <div key={ch.id} className={`notif-channel-card${ch.enabled ? '' : ' disabled'}`}>
              <div className="notif-channel-top">
                <div className="notif-channel-info">
                  <span className={`notif-type-badge ${ch.type}`}>{channelTypeName(ch.type)}</span>
                  <strong className="notif-channel-name">{ch.name}</strong>
                  {!ch.enabled && <span className="notif-disabled-badge">Disabled</span>}
                </div>
                <div className="notif-channel-actions">
                  <button
                    className="btn btn-xs btn-outline"
                    onClick={() => handleTest(ch.id)}
                    disabled={testing === ch.id || !ch.enabled}
                    title={!ch.enabled ? 'Enable the channel to test it' : 'Send a test notification'}
                  >
                    {testing === ch.id ? 'Sending…' : 'Test'}
                  </button>
                  <button
                    className="btn btn-xs btn-outline"
                    onClick={() => handleToggle(ch)}
                  >
                    {ch.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="btn btn-xs btn-outline"
                    onClick={() => setModal({ kind: 'edit', channel: ch })}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-xs btn-danger-outline"
                    onClick={() => setModal({ kind: 'delete', channel: ch })}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="notif-channel-detail">
                <ChannelConfigSummary type={ch.type as ChannelType} config={ch.config} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Supported types reference */}
      <details className="settings-help">
        <summary>Supported notification types</summary>
        <div className="settings-help-content">
          <ul>
            {CHANNEL_TYPES.map((t) => (
              <li key={t.value}><strong>{t.label}</strong> — {t.description}</li>
            ))}
          </ul>
          <p>
            <strong>Tip:</strong> For sensitive values (tokens, passwords), you can use environment
            variable references like <code>env:MY_TOKEN</code> instead of storing the actual value.
            The backend will resolve these at runtime from the container environment.
          </p>
        </div>
      </details>

      {/* ── Modals ── */}
      {(modal?.kind === 'create' || modal?.kind === 'edit') && (
        <ChannelFormModal
          mode={modal.kind}
          channel={modal.kind === 'edit' ? modal.channel : undefined}
          saving={saving}
          onSave={handleSaveChannel}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete Channel"
          message={`Are you sure you want to delete the channel "${modal.channel.name}"? Any notification rules using this channel will also be deleted.`}
          confirmLabel="Delete Channel"
          danger
          onConfirm={() => handleDelete(modal.channel.id)}
          onCancel={() => setModal(null)}
          saving={saving}
        />
      )}
      </>
      )}
    </div>
  );
}

// ── Channel config summary (read-only display) ──────────────

function ChannelConfigSummary({ type, config }: { type: ChannelType; config: Record<string, unknown> }) {
  const fields = CHANNEL_FIELDS[type] ?? [];
  if (fields.length === 0) return null;

  return (
    <div className="notif-config-summary">
      {fields.map((f) => {
        const val = config[f.key];
        if (val === undefined || val === null || val === '') return null;
        const display = f.type === 'password'
          ? maskValue(String(val))
          : String(val);
        return (
          <span key={f.key} className="notif-config-item">
            <span className="notif-config-label">{f.label}:</span>{' '}
            <code>{display}</code>
          </span>
        );
      })}
    </div>
  );
}

function maskValue(val: string): string {
  if (val.startsWith('env:')) return val; // env refs are safe to show
  if (val.length <= 6) return '****';
  return `${val.slice(0, 3)}${'*'.repeat(Math.max(3, val.length - 6))}${val.slice(-3)}`;
}

// ── Channel form modal ──────────────────────────────────────

function ChannelFormModal({
  mode,
  channel,
  saving,
  onSave,
  onCancel,
}: {
  mode: 'create' | 'edit';
  channel?: NotificationChannel;
  saving: boolean;
  onSave: (type: ChannelType, name: string, config: Record<string, unknown>, existingId?: string) => void;
  onCancel: () => void;
}) {
  const mouseDownOnOverlay = useRef(false);
  const [type, setType] = useState<ChannelType>(channel?.type ?? 'ntfy');
  const [name, setName] = useState(channel?.name ?? '');
  const [configValues, setConfigValues] = useState<Record<string, string>>(() => {
    if (!channel) return {};
    const vals: Record<string, string> = {};
    for (const [k, v] of Object.entries(channel.config)) {
      vals[k] = String(v ?? '');
    }
    return vals;
  });

  const fields = CHANNEL_FIELDS[type] ?? [];

  const handleFieldChange = (key: string, value: string) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const config: Record<string, unknown> = {};
    for (const f of fields) {
      const val = (configValues[f.key] ?? '').trim();
      if (val) config[f.key] = val;
    }
    onSave(type, name.trim(), config, channel?.id);
  };

  // When type changes in create mode, reset config values
  const handleTypeChange = (newType: ChannelType) => {
    setType(newType);
    if (mode === 'create') {
      setConfigValues({});
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnOverlay.current) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'create' ? 'Add Notification Channel' : 'Edit Channel'}
    >
      <div className="modal-content modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{mode === 'create' ? 'Add Notification Channel' : 'Edit Channel'}</h3>
        <form onSubmit={handleSubmit}>
          {/* Channel type (only for create) */}
          {mode === 'create' && (
            <div className="form-group">
              <label htmlFor="ch-type">Type</label>
              <select
                id="ch-type"
                value={type}
                onChange={(e) => handleTypeChange(e.target.value as ChannelType)}
              >
                {CHANNEL_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label} — {t.description}</option>
                ))}
              </select>
            </div>
          )}

          {/* Channel name */}
          <div className="form-group">
            <label htmlFor="ch-name">Name</label>
            <input
              id="ch-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production Alerts"
              required
              autoComplete="off"
            />
          </div>

          {/* Type-specific config fields */}
          {fields.map((f) => (
            <div className="form-group" key={f.key}>
              <label htmlFor={`ch-${f.key}`}>{f.label}{f.required && ' *'}</label>
              <input
                id={`ch-${f.key}`}
                type={f.type === 'password' ? 'text' : f.type}
                value={configValues[f.key] ?? ''}
                onChange={(e) => handleFieldChange(f.key, e.target.value)}
                placeholder={f.placeholder}
                required={f.required}
                autoComplete="off"
              />
              {f.hint && <span className="form-hint">{f.hint}</span>}
            </div>
          ))}

          {/* Setup guide for the selected channel type */}
          {CHANNEL_SETUP_GUIDES[type] && (
            <details className="channel-setup-guide" open={mode === 'create'}>
              <summary>{CHANNEL_SETUP_GUIDES[type]!.title}</summary>
              <ol className="channel-setup-steps">
                {CHANNEL_SETUP_GUIDES[type]!.steps.map((step, i) => (
                  <li key={i}>{step.replace(/^\d+\.\s*/, '')}</li>
                ))}
              </ol>
              <p className="form-hint" style={{ marginTop: '8px' }}>
                <strong>Tip:</strong> For sensitive values (tokens), you can use <code>env:VAR_NAME</code> to
                reference an environment variable from the Docker container instead of storing the value directly.
              </p>
            </details>
          )}

          <div className="modal-actions">
            <button type="submit" className="btn" disabled={saving}>
              {saving ? 'Saving…' : mode === 'create' ? 'Create Channel' : 'Save Changes'}
            </button>
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
