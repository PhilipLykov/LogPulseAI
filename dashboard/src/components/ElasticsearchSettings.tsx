import { useEffect, useState, useCallback } from 'react';
import {
  type EsConnection,
  type EsConnectionCreatePayload,
  type EsIndex,
  type EsFieldMapping,
  fetchEsConnections,
  createEsConnection,
  updateEsConnection,
  deleteEsConnection,
  testEsConnection,
  testEsConnectionRaw,
  fetchEsIndices,
  fetchEsIndexMapping,
  fetchEsIndexPreview,
} from '../api';

interface Props {
  onAuthError: () => void;
}

// ── Date formatter ───────────────────────────────────────────

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ── Status badge ─────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'connected' ? 'badge-ok' :
    status === 'error' ? 'badge-danger' : 'badge-muted';
  return <span className={`badge ${cls}`}>{status}</span>;
}

// ── Main component ───────────────────────────────────────────

export function ElasticsearchSettings({ onAuthError }: Props) {
  const [connections, setConnections] = useState<EsConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editConn, setEditConn] = useState<Partial<EsConnection & { credentials?: Record<string, string> }> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; cluster_name?: string; version?: string; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // Index browser state
  const [browseConnId, setBrowseConnId] = useState<string | null>(null);
  const [indices, setIndices] = useState<EsIndex[]>([]);
  const [indicesLoading, setIndicesLoading] = useState(false);
  const [indexPattern, setIndexPattern] = useState('*');
  const [selectedIndex, setSelectedIndex] = useState<string | null>(null);
  const [mapping, setMapping] = useState<EsFieldMapping[]>([]);
  const [preview, setPreview] = useState<Record<string, unknown>[]>([]);
  const [mappingLoading, setMappingLoading] = useState(false);

  // ── Load connections ─────────────────────────────────────────

  const loadConnections = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchEsConnections();
      setConnections(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => { loadConnections(); }, [loadConnections]);

  // ── CRUD handlers ────────────────────────────────────────────

  const handleNew = () => {
    setEditConn({
      name: '',
      url: 'https://',
      auth_type: 'basic',
      credentials: {},
      tls_reject_unauthorized: true,
      request_timeout_ms: 30000,
      max_retries: 3,
      pool_max_connections: 10,
      is_default: false,
    });
    setIsNew(true);
    setTestResult(null);
  };

  const handleEdit = (conn: EsConnection) => {
    setEditConn({ ...conn, credentials: {} });
    setIsNew(false);
    setTestResult(null);
  };

  const handleSave = async () => {
    if (!editConn?.name || !editConn?.url) {
      setError('Name and URL are required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (isNew) {
        await createEsConnection({
          name: editConn.name,
          url: editConn.url,
          auth_type: editConn.auth_type ?? 'none',
          credentials: editConn.credentials,
          tls_reject_unauthorized: editConn.tls_reject_unauthorized,
          ca_cert: editConn.ca_cert ?? undefined,
          request_timeout_ms: editConn.request_timeout_ms,
          max_retries: editConn.max_retries,
          pool_max_connections: editConn.pool_max_connections,
          is_default: editConn.is_default,
        });
      } else if (editConn.id) {
        const payload: Partial<EsConnectionCreatePayload> = {};
        if (editConn.name !== undefined) payload.name = editConn.name;
        if (editConn.url !== undefined) payload.url = editConn.url;
        if (editConn.auth_type !== undefined) payload.auth_type = editConn.auth_type;
        if (editConn.credentials && Object.keys(editConn.credentials).length > 0) {
          payload.credentials = editConn.credentials;
        }
        if (editConn.tls_reject_unauthorized !== undefined) payload.tls_reject_unauthorized = editConn.tls_reject_unauthorized;
        if (editConn.ca_cert !== undefined) payload.ca_cert = editConn.ca_cert ?? undefined;
        if (editConn.request_timeout_ms !== undefined) payload.request_timeout_ms = editConn.request_timeout_ms;
        if (editConn.max_retries !== undefined) payload.max_retries = editConn.max_retries;
        if (editConn.pool_max_connections !== undefined) payload.pool_max_connections = editConn.pool_max_connections;
        if (editConn.is_default !== undefined) payload.is_default = editConn.is_default;
        await updateEsConnection(editConn.id, payload);
      }
      setEditConn(null);
      await loadConnections();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this Elasticsearch connection?')) return;
    try {
      await deleteEsConnection(id);
      await loadConnections();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (editConn?.id && !isNew) {
        const result = await testEsConnection(editConn.id);
        setTestResult(result);
      } else if (editConn) {
        const result = await testEsConnectionRaw({
          url: editConn.url,
          auth_type: editConn.auth_type,
          credentials: editConn.credentials,
          tls_reject_unauthorized: editConn.tls_reject_unauthorized,
          ca_cert: editConn.ca_cert ?? undefined,
          request_timeout_ms: editConn.request_timeout_ms ?? 10000,
        });
        setTestResult(result);
      }
    } catch (err: unknown) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  // ── Index browser handlers ───────────────────────────────────

  const handleBrowseIndices = async (connId: string) => {
    setBrowseConnId(connId);
    setIndicesLoading(true);
    setIndices([]);
    setSelectedIndex(null);
    setMapping([]);
    setPreview([]);
    try {
      const data = await fetchEsIndices(connId, indexPattern);
      setIndices(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndicesLoading(false);
    }
  };

  const handleSelectIndex = async (connId: string, indexName: string) => {
    setSelectedIndex(indexName);
    setMappingLoading(true);
    try {
      const [mappingResult, previewResult] = await Promise.all([
        fetchEsIndexMapping(connId, indexName),
        fetchEsIndexPreview(connId, indexName, 3),
      ]);
      setMapping(mappingResult.fields);
      setPreview(previewResult.sample.map(d => d._source));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMappingLoading(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="settings-section">
      <div className="section-header">
        <h3>Elasticsearch Connections</h3>
        <button className="btn btn-sm" onClick={handleNew}>+ Add Connection</button>
      </div>

      {error && (
        <div className="error-msg" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss">&times;</button>
        </div>
      )}

      {/* ── Connection list ── */}
      {loading ? (
        <div className="settings-loading"><div className="spinner" /> Loading...</div>
      ) : connections.length === 0 && !editConn ? (
        <div className="settings-empty">
          <p>No Elasticsearch connections configured.</p>
          <p className="settings-empty-hint">Click "+ Add Connection" to connect to an Elasticsearch cluster.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>URL</th>
                <th>Auth</th>
                <th>Status</th>
                <th>Last Check</th>
                <th>Default</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {connections.map(conn => (
                <tr key={conn.id}>
                  <td className="fw-medium">{conn.name}</td>
                  <td><code className="text-sm">{conn.url}</code></td>
                  <td>{conn.auth_type}</td>
                  <td><StatusBadge status={conn.status} /></td>
                  <td className="text-sm">{fmtDate(conn.last_health_check_at)}</td>
                  <td>{conn.is_default ? 'Yes' : ''}</td>
                  <td className="actions-cell">
                    <button className="btn btn-xs" onClick={() => handleEdit(conn)}>Edit</button>
                    <button className="btn btn-xs" onClick={() => handleBrowseIndices(conn.id)}>Browse</button>
                    <button className="btn btn-xs btn-danger-outline" onClick={() => handleDelete(conn.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Edit / Create form ── */}
      {editConn && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="card-header">
            <h4>{isNew ? 'New Elasticsearch Connection' : `Edit: ${editConn.name}`}</h4>
          </div>
          <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <label className="form-group">
              <span className="form-label">Name</span>
              <input
                type="text"
                className="form-input"
                value={editConn.name ?? ''}
                onChange={e => setEditConn({ ...editConn, name: e.target.value })}
                placeholder="Production ES Cluster"
              />
            </label>
            <label className="form-group">
              <span className="form-label">URL</span>
              <input
                type="text"
                className="form-input"
                value={editConn.url ?? ''}
                onChange={e => setEditConn({ ...editConn, url: e.target.value })}
                placeholder="https://elasticsearch.example.com:9200"
              />
            </label>
            <label className="form-group">
              <span className="form-label">Authentication</span>
              <select
                className="form-input"
                value={editConn.auth_type ?? 'none'}
                onChange={e => setEditConn({ ...editConn, auth_type: e.target.value as EsConnection['auth_type'] })}
              >
                <option value="none">None</option>
                <option value="basic">Basic (Username / Password)</option>
                <option value="api_key">API Key</option>
                <option value="cloud_id">Elastic Cloud</option>
              </select>
            </label>

            {editConn.auth_type === 'basic' && (
              <>
                <label className="form-group">
                  <span className="form-label">Username</span>
                  <input
                    type="text"
                    className="form-input"
                    value={editConn.credentials?.username ?? ''}
                    onChange={e => setEditConn({
                      ...editConn,
                      credentials: { ...editConn.credentials, username: e.target.value },
                    })}
                    placeholder="elastic"
                    autoComplete="off"
                  />
                </label>
                <label className="form-group">
                  <span className="form-label">Password</span>
                  <input
                    type="password"
                    className="form-input"
                    value={editConn.credentials?.password ?? ''}
                    onChange={e => setEditConn({
                      ...editConn,
                      credentials: { ...editConn.credentials, password: e.target.value },
                    })}
                    placeholder={isNew ? '' : '(unchanged)'}
                    autoComplete="off"
                  />
                </label>
              </>
            )}

            {editConn.auth_type === 'api_key' && (
              <label className="form-group" style={{ gridColumn: '1 / -1' }}>
                <span className="form-label">API Key</span>
                <input
                  type="password"
                  className="form-input"
                  value={editConn.credentials?.api_key ?? ''}
                  onChange={e => setEditConn({
                    ...editConn,
                    credentials: { ...editConn.credentials, api_key: e.target.value },
                  })}
                  placeholder={isNew ? 'base64-encoded API key' : '(unchanged)'}
                  autoComplete="off"
                />
              </label>
            )}

            {editConn.auth_type === 'cloud_id' && (
              <>
                <label className="form-group">
                  <span className="form-label">Cloud ID</span>
                  <input
                    type="text"
                    className="form-input"
                    value={editConn.credentials?.cloud_id ?? ''}
                    onChange={e => setEditConn({
                      ...editConn,
                      credentials: { ...editConn.credentials, cloud_id: e.target.value },
                    })}
                    placeholder="deployment:region:hash"
                  />
                </label>
                <label className="form-group">
                  <span className="form-label">API Key (for Cloud)</span>
                  <input
                    type="password"
                    className="form-input"
                    value={editConn.credentials?.api_key ?? ''}
                    onChange={e => setEditConn({
                      ...editConn,
                      credentials: { ...editConn.credentials, api_key: e.target.value },
                    })}
                    placeholder={isNew ? '' : '(unchanged)'}
                    autoComplete="off"
                  />
                </label>
              </>
            )}

            <label className="form-group">
              <span className="form-label">Request Timeout (ms)</span>
              <input
                type="number"
                className="form-input"
                value={editConn.request_timeout_ms ?? 30000}
                onChange={e => setEditConn({ ...editConn, request_timeout_ms: Number(e.target.value) })}
                min={1000}
                max={120000}
              />
            </label>
            <label className="form-group">
              <span className="form-label">Max Retries</span>
              <input
                type="number"
                className="form-input"
                value={editConn.max_retries ?? 3}
                onChange={e => setEditConn({ ...editConn, max_retries: Number(e.target.value) })}
                min={0}
                max={10}
              />
            </label>
            <label className="form-group">
              <span className="form-label">Pool Max Connections</span>
              <input
                type="number"
                className="form-input"
                value={editConn.pool_max_connections ?? 10}
                onChange={e => setEditConn({ ...editConn, pool_max_connections: Number(e.target.value) })}
                min={1}
                max={100}
              />
            </label>

            <label className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={editConn.tls_reject_unauthorized ?? true}
                onChange={e => setEditConn({ ...editConn, tls_reject_unauthorized: e.target.checked })}
              />
              <span>Verify TLS certificate</span>
            </label>

            <label className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={editConn.is_default ?? false}
                onChange={e => setEditConn({ ...editConn, is_default: e.target.checked })}
              />
              <span>Default connection</span>
            </label>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`alert ${testResult.ok ? 'alert-success' : 'alert-danger'}`} style={{ margin: '0.5rem 1rem' }}>
              {testResult.ok ? (
                <span>Connected to cluster <strong>{testResult.cluster_name}</strong> (ES {testResult.version})</span>
              ) : (
                <span>Connection failed: {testResult.error}</span>
              )}
            </div>
          )}

          <div className="card-footer" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={handleTest} disabled={testing}>
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
            <button className="btn" onClick={() => { setEditConn(null); setTestResult(null); }}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : (isNew ? 'Create' : 'Save')}
            </button>
          </div>
        </div>
      )}

      {/* ── Index browser ── */}
      {browseConnId && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h4>Index Browser: {connections.find(c => c.id === browseConnId)?.name ?? browseConnId}</h4>
            <button className="btn btn-xs" onClick={() => { setBrowseConnId(null); setIndices([]); setSelectedIndex(null); }}>Close</button>
          </div>

          <div className="card-body">
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <input
                type="text"
                className="form-input"
                value={indexPattern}
                onChange={e => setIndexPattern(e.target.value)}
                placeholder="Index pattern (e.g. filebeat-*)"
                style={{ flex: 1 }}
              />
              <button className="btn btn-sm" onClick={() => handleBrowseIndices(browseConnId)}>
                {indicesLoading ? 'Loading...' : 'Refresh'}
              </button>
            </div>

            {indices.length > 0 && (
              <div className="table-wrap" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                <table className="data-table data-table-compact">
                  <thead>
                    <tr>
                      <th>Index</th>
                      <th>Health</th>
                      <th>Docs</th>
                      <th>Size</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {indices.map(idx => (
                      <tr key={idx.index} className={selectedIndex === idx.index ? 'row-active' : ''}>
                        <td><code className="text-sm">{idx.index}</code></td>
                        <td>
                          <span className={`badge ${idx.health === 'green' ? 'badge-ok' : idx.health === 'yellow' ? 'badge-warn' : 'badge-danger'}`}>
                            {idx.health ?? '?'}
                          </span>
                        </td>
                        <td className="text-right">{idx['docs.count'] ?? '—'}</td>
                        <td className="text-right">{idx['store.size'] ?? '—'}</td>
                        <td>
                          <button
                            className="btn btn-xs"
                            onClick={() => handleSelectIndex(browseConnId, idx.index)}
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Selected index details */}
            {selectedIndex && (
              <div style={{ marginTop: '1rem' }}>
                <h5>Index: <code>{selectedIndex}</code></h5>
                {mappingLoading ? (
                  <div className="settings-loading"><div className="spinner" /> Loading mapping...</div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    {/* Field mapping */}
                    <div>
                      <h6>Field Mapping ({mapping.length} fields)</h6>
                      <div className="table-wrap" style={{ maxHeight: '250px', overflowY: 'auto' }}>
                        <table className="data-table data-table-compact">
                          <thead><tr><th>Field</th><th>Type</th></tr></thead>
                          <tbody>
                            {mapping.map(f => (
                              <tr key={f.path}>
                                <td><code className="text-sm">{f.path}</code></td>
                                <td className="text-sm">{f.type}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Sample documents */}
                    <div>
                      <h6>Sample Documents ({preview.length})</h6>
                      <div style={{ maxHeight: '250px', overflowY: 'auto' }}>
                        {preview.map((doc, i) => (
                          <pre
                            key={i}
                            className="code-block"
                            style={{ fontSize: '0.75rem', maxHeight: '150px', overflowY: 'auto', marginBottom: '0.5rem' }}
                          >
                            {JSON.stringify(doc, null, 2)}
                          </pre>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
