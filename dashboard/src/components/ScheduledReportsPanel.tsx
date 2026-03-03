import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type NotificationChannel,
  type ScheduledReport,
  fetchNotificationChannels,
  fetchScheduledReports,
  createScheduledReport,
  updateScheduledReport,
  deleteScheduledReport,
  runScheduledReportNow,
} from '../api';
import { ConfirmDialog } from './ConfirmDialog';
import { formatEuDateTime } from '../utils/dateTime';

interface ScheduledReportsPanelProps {
  onAuthError: () => void;
}

type Modal =
  | { kind: 'create' }
  | { kind: 'edit'; report: ScheduledReport }
  | { kind: 'delete'; report: ScheduledReport }
  | null;

const SCHEDULE_PRESETS = [
  { value: '*/15 * * * *', label: 'Every 15 minutes' },
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 0 * * *', label: 'Daily (00:00 UTC)' },
  { value: '0 0 * * 1', label: 'Weekly (Monday, 00:00 UTC)' },
];

const LOOKBACK_OPTIONS = [
  { value: 6, label: 'Last 6 hours' },
  { value: 24, label: 'Last 24 hours' },
  { value: 72, label: 'Last 3 days' },
  { value: 168, label: 'Last 7 days' },
];

function scheduleLabel(schedule: string): string {
  return SCHEDULE_PRESETS.find((p) => p.value === schedule)?.label ?? schedule;
}

function getLookbackHours(report: ScheduledReport): number {
  const raw = Number(report.filters?.lookback_hours ?? 24);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 24;
}

export function ScheduledReportsPanel({ onAuthError }: ScheduledReportsPanelProps) {
  const [reports, setReports] = useState<ScheduledReport[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [modal, setModal] = useState<Modal>(null);

  const channelNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const ch of channels) map.set(ch.id, ch.name);
    return map;
  }, [channels]);

  const handleApiError = useCallback((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Authentication')) {
      onAuthError();
      return;
    }
    setError(msg);
  }, [onAuthError]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [reportRows, channelRows] = await Promise.all([
        fetchScheduledReports(),
        fetchNotificationChannels(),
      ]);
      setReports(reportRows);
      setChannels(channelRows);
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }, [handleApiError]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = useCallback(async (
    data: {
      name: string;
      channel_id: string | null;
      schedule: string;
      report_type: 'summary' | 'json' | 'csv';
      lookback_hours: number;
    },
    existing?: ScheduledReport,
  ) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const nextFilters = {
        ...(existing?.filters ?? {}),
        lookback_hours: data.lookback_hours,
      };
      if (existing) {
        const updated = await updateScheduledReport(existing.id, {
          name: data.name,
          channel_id: data.channel_id,
          schedule: data.schedule,
          report_type: data.report_type,
          filters: nextFilters,
        });
        setReports((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        setSuccess(`Scheduled report "${updated.name}" updated.`);
      } else {
        const created = await createScheduledReport({
          name: data.name,
          channel_id: data.channel_id,
          schedule: data.schedule,
          report_type: data.report_type,
          filters: nextFilters,
          enabled: true,
        });
        setReports((prev) => [created, ...prev]);
        setSuccess(`Scheduled report "${created.name}" created.`);
      }
      setModal(null);
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setSaving(false);
    }
  }, [handleApiError]);

  const handleToggleEnabled = useCallback(async (report: ScheduledReport) => {
    setError('');
    setSuccess('');
    try {
      const updated = await updateScheduledReport(report.id, { enabled: !report.enabled });
      setReports((prev) => prev.map((r) => (r.id === report.id ? updated : r)));
      setSuccess(`Scheduled report "${report.name}" ${updated.enabled ? 'enabled' : 'disabled'}.`);
    } catch (err: unknown) {
      handleApiError(err);
    }
  }, [handleApiError]);

  const handleRunNow = useCallback(async (report: ScheduledReport) => {
    setRunningId(report.id);
    setError('');
    setSuccess('');
    try {
      const response = await runScheduledReportNow(report.id);
      setReports((prev) => prev.map((r) => (r.id === report.id ? response.report : r)));
      setSuccess(`Scheduled report "${report.name}" executed.`);
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setRunningId(null);
    }
  }, [handleApiError]);

  const handleDelete = useCallback(async (report: ScheduledReport) => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await deleteScheduledReport(report.id);
      setReports((prev) => prev.filter((r) => r.id !== report.id));
      setSuccess(`Scheduled report "${report.name}" deleted.`);
      setModal(null);
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setSaving(false);
    }
  }, [handleApiError]);

  if (loading) {
    return <div className="settings-loading"><div className="spinner" /> Loading scheduled reports…</div>;
  }

  return (
    <div className="scheduled-reports-panel">
      <div className="notif-header">
        <div>
          <h3>Scheduled Reports</h3>
          <p className="notif-desc">
            Periodically generate compliance snapshots and send them to notification channels.
          </p>
        </div>
        <button className="btn btn-sm" onClick={() => setModal({ kind: 'create' })}>
          + Add Scheduled Report
        </button>
      </div>

      {error && (
        <div className="error-msg" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss">&times;</button>
        </div>
      )}
      {success && (
        <div className="success-msg" role="status">
          {success}
          <button className="error-dismiss" onClick={() => setSuccess('')} aria-label="Dismiss">&times;</button>
        </div>
      )}

      {reports.length === 0 ? (
        <div className="notif-empty">
          <div className="notif-empty-icon" aria-hidden="true">&#128196;</div>
          <h4>No scheduled reports</h4>
          <p>Create a report to send periodic JSON/CSV compliance snapshots to your channels.</p>
        </div>
      ) : (
        <div className="notif-channel-list">
          {reports.map((report) => {
            const channelName = report.channel_name
              ?? (report.channel_id ? channelNameById.get(report.channel_id) : null)
              ?? 'No channel';
            return (
              <div key={report.id} className={`notif-channel-card${report.enabled ? '' : ' disabled'}`}>
                <div className="notif-channel-top">
                  <div className="notif-channel-info">
                    <span className="notif-type-badge webhook">Report</span>
                    <strong className="notif-channel-name">{report.name}</strong>
                    {!report.enabled && <span className="notif-disabled-badge">Disabled</span>}
                  </div>
                  <div className="notif-channel-actions">
                    <button
                      className="btn btn-xs btn-outline"
                      onClick={() => handleRunNow(report)}
                      disabled={runningId === report.id}
                    >
                      {runningId === report.id ? 'Running…' : 'Run Now'}
                    </button>
                    <button
                      className="btn btn-xs btn-outline"
                      onClick={() => handleToggleEnabled(report)}
                    >
                      {report.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      className="btn btn-xs btn-outline"
                      onClick={() => setModal({ kind: 'edit', report })}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-xs btn-danger-outline"
                      onClick={() => setModal({ kind: 'delete', report })}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="notif-channel-detail">
                  <span className="notif-config-item">
                    <span className="notif-config-label">Schedule:</span> <code>{scheduleLabel(report.schedule)}</code>
                  </span>
                  <span className="notif-config-item">
                    <span className="notif-config-label">Format:</span> <code>{report.report_type.toUpperCase()}</code>
                  </span>
                  <span className="notif-config-item">
                    <span className="notif-config-label">Lookback:</span> <code>{getLookbackHours(report)}h</code>
                  </span>
                  <span className="notif-config-item">
                    <span className="notif-config-label">Channel:</span> <code>{channelName}</code>
                  </span>
                </div>
                <div className="notif-channel-detail">
                  <span className="notif-config-item">
                    <span className="notif-config-label">Last run:</span>{' '}
                    <code>{formatEuDateTime(report.last_run_at)}</code>
                  </span>
                  <span className="notif-config-item">
                    <span className="notif-config-label">Next run:</span>{' '}
                    <code>{formatEuDateTime(report.next_run_at)}</code>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(modal?.kind === 'create' || modal?.kind === 'edit') && (
        <ScheduledReportFormModal
          mode={modal.kind}
          report={modal.kind === 'edit' ? modal.report : undefined}
          channels={channels}
          saving={saving}
          onSave={handleSave}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete Scheduled Report"
          message={`Delete scheduled report "${modal.report.name}"?`}
          confirmLabel="Delete Report"
          danger
          saving={saving}
          onConfirm={() => handleDelete(modal.report)}
          onCancel={() => setModal(null)}
        />
      )}
    </div>
  );
}

function ScheduledReportFormModal({
  mode,
  report,
  channels,
  saving,
  onSave,
  onCancel,
}: {
  mode: 'create' | 'edit';
  report?: ScheduledReport;
  channels: NotificationChannel[];
  saving: boolean;
  onSave: (
    data: {
      name: string;
      channel_id: string | null;
      schedule: string;
      report_type: 'summary' | 'json' | 'csv';
      lookback_hours: number;
    },
    existing?: ScheduledReport,
  ) => void;
  onCancel: () => void;
}) {
  const mouseDownOnOverlay = useRef(false);
  const initialLookbackHours = report ? getLookbackHours(report) : 24;
  const [name, setName] = useState(report?.name ?? '');
  const [channelId, setChannelId] = useState(report?.channel_id ?? '');
  const isCustomSchedule = report?.schedule && !SCHEDULE_PRESETS.some((p) => p.value === report.schedule);
  const isCustomLookback = report && !LOOKBACK_OPTIONS.some((o) => o.value === initialLookbackHours);
  const [schedule, setSchedule] = useState(report?.schedule ?? SCHEDULE_PRESETS[0].value);
  const [customSchedule, setCustomSchedule] = useState(isCustomSchedule ? report!.schedule : '');
  const [useCustomSchedule, setUseCustomSchedule] = useState(!!isCustomSchedule);
  const [reportType, setReportType] = useState<'summary' | 'json' | 'csv'>(report?.report_type ?? 'summary');
  const [lookbackHours, setLookbackHours] = useState<number>(initialLookbackHours);
  const [customLookback, setCustomLookback] = useState(isCustomLookback ? String(initialLookbackHours) : '');
  const [useCustomLookback, setUseCustomLookback] = useState(!!isCustomLookback);

  const effectiveSchedule = useCustomSchedule ? customSchedule.trim() : schedule;
  const effectiveLookback = useCustomLookback ? (Number(customLookback) || 24) : lookbackHours;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name: name.trim(),
      channel_id: channelId || null,
      schedule: effectiveSchedule,
      report_type: reportType,
      lookback_hours: effectiveLookback,
    }, report);
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnOverlay.current) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'create' ? 'Add Scheduled Report' : 'Edit Scheduled Report'}
    >
      <div className="modal-content modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{mode === 'create' ? 'Add Scheduled Report' : 'Edit Scheduled Report'}</h3>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="sr-name">Name</label>
            <input
              id="sr-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Daily Compliance Snapshot"
              required
              autoComplete="off"
            />
          </div>

          <div className="form-group">
            <label htmlFor="sr-channel">Channel</label>
            <select
              id="sr-channel"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
            >
              <option value="">None (run without sending notifications)</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.name} ({ch.type})
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="sr-schedule">Schedule</label>
              {useCustomSchedule ? (
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <input
                    id="sr-schedule"
                    type="text"
                    value={customSchedule}
                    onChange={(e) => setCustomSchedule(e.target.value)}
                    placeholder="e.g. */5 * * * *"
                    required
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="btn btn-xs btn-outline" onClick={() => { setUseCustomSchedule(false); setSchedule(SCHEDULE_PRESETS[0].value); }}>
                    Presets
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <select
                    id="sr-schedule"
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                    style={{ flex: 1 }}
                  >
                    {SCHEDULE_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                  <button type="button" className="btn btn-xs btn-outline" onClick={() => setUseCustomSchedule(true)}>
                    Custom
                  </button>
                </div>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="sr-type">Format</label>
              <select
                id="sr-type"
                value={reportType}
                onChange={(e) => setReportType(e.target.value as 'summary' | 'json' | 'csv')}
              >
                <option value="summary">Summary (JSON payload)</option>
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="sr-lookback">Lookback window</label>
            {useCustomLookback ? (
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <input
                  id="sr-lookback"
                  type="number"
                  min={1}
                  value={customLookback}
                  onChange={(e) => setCustomLookback(e.target.value)}
                  placeholder="Hours"
                  required
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: '0.85rem', opacity: 0.7 }}>hours</span>
                <button type="button" className="btn btn-xs btn-outline" onClick={() => { setUseCustomLookback(false); setLookbackHours(24); }}>
                  Presets
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <select
                  id="sr-lookback"
                  value={lookbackHours}
                  onChange={(e) => setLookbackHours(Number(e.target.value))}
                  style={{ flex: 1 }}
                >
                  {LOOKBACK_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button type="button" className="btn btn-xs btn-outline" onClick={() => setUseCustomLookback(true)}>
                  Custom
                </button>
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button type="submit" className="btn" disabled={saving}>
              {saving ? 'Saving…' : mode === 'create' ? 'Create Report' : 'Save Changes'}
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
