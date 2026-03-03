import { useState, useRef, useEffect } from 'react';
import { fetchParseProfiles, type ParseProfileSummary } from '../api';

interface SourceFormProps {
  title: string;
  initialLabel?: string;
  initialSelector?: Record<string, string> | Record<string, string>[];
  initialPriority?: number;
  initialParseProfile?: string | null;
  onSave: (
    label: string,
    selector: Record<string, string> | Record<string, string>[],
    priority: number,
    parseProfile: string | null,
  ) => void;
  onCancel: () => void;
  saving: boolean;
}

/** Known event fields that can be used in selectors. */
const SELECTOR_FIELDS = ['host', 'source_ip', 'service', 'program', 'facility', 'severity'] as const;

interface SelectorRow {
  field: string;
  pattern: string;
}

interface SelectorGroup {
  rows: SelectorRow[];
}

function selectorToGroups(selector: Record<string, string> | Record<string, string>[]): SelectorGroup[] {
  if (Array.isArray(selector)) {
    return selector.map(group => ({
      rows: Object.entries(group).map(([field, pattern]) => ({ field, pattern })),
    })).map(g => g.rows.length > 0 ? g : { rows: [{ field: 'host', pattern: '' }] });
  }
  const rows = Object.entries(selector).map(([field, pattern]) => ({ field, pattern }));
  return [{ rows: rows.length > 0 ? rows : [{ field: 'host', pattern: '' }] }];
}

/**
 * Auto-escape plain IP addresses and hostnames that the user entered
 * without regex syntax. Dots in a plain IP like `192.168.30.14` would
 * otherwise match any character; this converts it to `^192\.168\.30\.14$`.
 */
function autoEscapePattern(field: string, pattern: string): string {
  const trimmed = pattern.trim();
  if (!trimmed || !trimmed.includes('.')) return trimmed;
  // Already contains regex metacharacters — user knows what they're doing
  if (/[\\^$*+?[\](){}|]/.test(trimmed)) return trimmed;

  if (field === 'source_ip') {
    // Full IPv4: 192.168.30.14
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
      return `^${trimmed.replace(/\./g, '\\.')}$`;
    }
    // IP prefix ending with dot: 192.168.30. or 192.168.
    if (/^\d{1,3}(\.\d{1,3})*\.$/.test(trimmed)) {
      return `^${trimmed.replace(/\./g, '\\.')}`;
    }
  }

  if (field === 'host') {
    // Plain hostname with dots: web-01.example.com
    if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(trimmed)) {
      return `^${trimmed.replace(/\./g, '\\.')}$`;
    }
  }

  return trimmed;
}

function groupsToSelector(groups: SelectorGroup[]): Record<string, string> | Record<string, string>[] {
  const validGroups = groups
    .map(g => {
      const result: Record<string, string> = {};
      for (const row of g.rows) {
        const field = row.field.trim();
        const pattern = row.pattern.trim();
        if (field && pattern) result[field] = autoEscapePattern(field, pattern);
      }
      return result;
    })
    .filter(g => Object.keys(g).length > 0);

  if (validGroups.length === 0) return {};
  if (validGroups.length === 1) return validGroups[0];
  return validGroups;
}

function profileCategoryLabel(category: ParseProfileSummary['category']): string {
  switch (category) {
    case 'database': return 'Database';
    case 'webserver': return 'Web Server';
    case 'network': return 'Network';
    case 'system': return 'System';
    case 'security': return 'Security';
    case 'messaging': return 'Messaging';
    case 'general': return 'General';
    default: return category;
  }
}

export function SourceForm({
  title,
  initialLabel = '',
  initialSelector,
  initialPriority = 0,
  initialParseProfile = null,
  onSave,
  onCancel,
  saving,
}: SourceFormProps) {
  const [label, setLabel] = useState(initialLabel);
  const [groups, setGroups] = useState<SelectorGroup[]>(
    selectorToGroups(initialSelector ?? {}),
  );
  const [priority, setPriority] = useState(String(initialPriority));
  const [parseProfile, setParseProfile] = useState<string>(initialParseProfile ?? '');
  const [parseProfiles, setParseProfiles] = useState<ParseProfileSummary[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const labelRef = useRef<HTMLInputElement>(null);
  const mouseDownOnOverlay = useRef(false);
  const selectedProfile = parseProfiles.find((p) => p.id === parseProfile) ?? null;
  const groupedProfiles = parseProfiles.reduce<Record<string, ParseProfileSummary[]>>((acc, profile) => {
    const key = profile.category;
    if (!acc[key]) acc[key] = [];
    acc[key].push(profile);
    return acc;
  }, {});

  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setProfilesLoading(true);
      try {
        const profiles = await fetchParseProfiles();
        if (mounted) {
          setParseProfiles(profiles);
        }
      } catch {
        // Non-critical: keep "None" as a safe fallback.
      } finally {
        if (mounted) {
          setProfilesLoading(false);
        }
      }
    })();
    return () => { mounted = false; };
  }, []);

  const updateGroupRow = (gi: number, ri: number, field: Partial<SelectorRow>) => {
    setGroups(prev => prev.map((g, i) => i === gi
      ? { rows: g.rows.map((r, j) => j === ri ? { ...r, ...field } : r) }
      : g
    ));
  };

  const addRowToGroup = (gi: number) => {
    setGroups(prev => prev.map((g, i) => i === gi
      ? { rows: [...g.rows, { field: 'host', pattern: '' }] }
      : g
    ));
  };

  const removeGroupRow = (gi: number, ri: number) => {
    setGroups(prev => {
      const newGroups = prev.map((g, i) => {
        if (i !== gi) return g;
        if (g.rows.length <= 1) return g;
        return { rows: g.rows.filter((_, j) => j !== ri) };
      });
      return newGroups;
    });
  };

  const addGroup = () => {
    setGroups(prev => [...prev, { rows: [{ field: 'host', pattern: '' }] }]);
  };

  const removeGroup = (gi: number) => {
    setGroups(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== gi));
  };

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!label.trim()) errs.label = 'Label is required.';

    const selector = groupsToSelector(groups);
    const selectorEmpty = Array.isArray(selector) ? selector.length === 0 : Object.keys(selector).length === 0;
    if (selectorEmpty) {
      errs.selector = 'At least one selector rule with a non-empty pattern is required.';
    }

    for (let gi = 0; gi < groups.length; gi++) {
      const usedFields = new Set<string>();
      for (let ri = 0; ri < groups[gi].rows.length; ri++) {
        const fieldName = groups[gi].rows[ri].field.trim();
        if (fieldName) {
          if (usedFields.has(fieldName)) {
            errs[`group-${gi}-duplicate`] =
              `Field "${fieldName}" is duplicated in this AND group. Use one condition per field.`;
          } else {
            usedFields.add(fieldName);
          }
        }

        const pattern = groups[gi].rows[ri].pattern.trim();
        if (pattern) {
          try { new RegExp(pattern); } catch { errs[`pattern-${gi}-${ri}`] = 'Invalid regex pattern.'; }
        }
      }
    }

    const parsedPriority = Number(priority);
    if (!Number.isFinite(parsedPriority) || parsedPriority < 0) {
      errs.priority = 'Priority must be a non-negative number.';
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    const selector = groupsToSelector(groups);
    onSave(label.trim(), selector, Number(priority), parseProfile || null);
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && mouseDownOnOverlay.current) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal-content modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <form onSubmit={handleSubmit}>
          {/* Label */}
          <div className="form-group">
            <label htmlFor="source-label">Label *</label>
            <input
              ref={labelRef}
              id="source-label"
              type="text"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                if (errors.label) setErrors((prev) => ({ ...prev, label: '' }));
              }}
              placeholder="e.g. Nginx logs, All syslog, Auth events"
              maxLength={255}
              aria-required="true"
              aria-invalid={!!errors.label}
            />
            {errors.label && <span className="field-error">{errors.label}</span>}
          </div>

          {/* Selector rules */}
          <div className="form-group">
            <label>Selector Rules *</label>
            <div className="selector-editor" role="group" aria-label="Selector rules">
              {groups.map((group, gi) => (
                <div key={gi}>
                  {gi > 0 && (
                    <div className="selector-or-divider">
                      <span>OR</span>
                    </div>
                  )}
                  <div className="selector-group">
                    {group.rows.map((row, ri) => (
                      <div key={ri} className="selector-row">
                        {ri > 0 && <span className="selector-and-label">AND</span>}
                        <select
                          value={row.field}
                          onChange={(e) => updateGroupRow(gi, ri, { field: e.target.value })}
                          aria-label={`Field for group ${gi + 1} rule ${ri + 1}`}
                          className="selector-field"
                        >
                          {SELECTOR_FIELDS.map((f) => (
                            <option
                              key={f}
                              value={f}
                              disabled={group.rows.some((r, idx) => idx !== ri && r.field === f)}
                            >
                              {f}
                            </option>
                          ))}
                        </select>
                        <span className="selector-operator">matches</span>
                        <input
                          type="text"
                          value={row.pattern}
                          onChange={(e) => {
                            updateGroupRow(gi, ri, { pattern: e.target.value });
                            if (errors[`pattern-${gi}-${ri}`]) {
                              setErrors((prev) => ({ ...prev, [`pattern-${gi}-${ri}`]: '' }));
                            }
                          }}
                          onBlur={() => {
                            const escaped = autoEscapePattern(row.field, row.pattern);
                            if (escaped !== row.pattern.trim()) {
                              updateGroupRow(gi, ri, { pattern: escaped });
                            }
                          }}
                          placeholder={row.field === 'source_ip'
                            ? 'IP or regex (e.g. 192.168.30.14 or ^10\\.0\\.)'
                            : 'regex pattern (e.g. .* or ^web-[0-9]+)'}
                          className={`selector-pattern${errors[`pattern-${gi}-${ri}`] ? ' input-error' : ''}`}
                          aria-label={`Pattern for group ${gi + 1} rule ${ri + 1}`}
                        />
                        <button
                          type="button"
                          className="btn btn-xs btn-icon btn-outline"
                          onClick={() => removeGroupRow(gi, ri)}
                          disabled={group.rows.length <= 1}
                          aria-label={`Remove rule`}
                          title="Remove condition"
                        >
                          &times;
                        </button>
                        {errors[`pattern-${gi}-${ri}`] && (
                          <span className="field-error selector-row-error">{errors[`pattern-${gi}-${ri}`]}</span>
                        )}
                      </div>
                    ))}
                    <div className="selector-group-actions">
                      <button type="button" className="btn btn-xs btn-outline" onClick={() => addRowToGroup(gi)}>
                        + AND condition
                      </button>
                      {groups.length > 1 && (
                        <button type="button" className="btn btn-xs btn-outline btn-danger-outline" onClick={() => removeGroup(gi)}>
                          Remove group
                        </button>
                      )}
                    </div>
                    {errors[`group-${gi}-duplicate`] && (
                      <span className="field-error" style={{ marginTop: '6px', display: 'block' }}>
                        {errors[`group-${gi}-duplicate`]}
                      </span>
                    )}
                  </div>
                </div>
              ))}
              <button type="button" className="btn btn-xs btn-outline selector-add-btn" onClick={addGroup} style={{ marginTop: '0.5rem' }}>
                + OR group
              </button>
            </div>
            {errors.selector && <span className="field-error">{errors.selector}</span>}
          </div>

          {/* Priority */}
          <div className="form-group">
            <label htmlFor="source-priority">Priority</label>
            <input
              id="source-priority"
              type="text"
              inputMode="numeric"
              value={priority}
              onChange={(e) => {
                setPriority(e.target.value);
                if (errors.priority) setErrors((prev) => ({ ...prev, priority: '' }));
              }}
              className="input-short"
              aria-describedby="priority-help"
              aria-invalid={!!errors.priority}
            />
            <span id="priority-help" className="field-hint">
              Lower priority = evaluated first. Use 0 for specific rules, 100 for catch-all rules.
            </span>
            {errors.priority && <span className="field-error">{errors.priority}</span>}
          </div>

          {/* Parse Profile */}
          <div className="form-group">
            <label htmlFor="source-parse-profile">Parse Profile</label>
            <select
              id="source-parse-profile"
              value={parseProfile}
              onChange={(e) => setParseProfile(e.target.value)}
              className="form-input"
              disabled={profilesLoading}
            >
              <option value="">None (generic parsing)</option>
              {Object.entries(groupedProfiles)
                .sort(([a], [b]) =>
                  profileCategoryLabel(a as ParseProfileSummary['category'])
                    .localeCompare(profileCategoryLabel(b as ParseProfileSummary['category'])),
                )
                .map(([category, items]) => (
                <optgroup key={category} label={profileCategoryLabel(category as ParseProfileSummary['category'])}>
                  {items
                    .slice()
                    .sort((a, b) => a.label.localeCompare(b.label))
                    .map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span className="field-hint">
              {profilesLoading
                ? 'Loading parse profiles...'
                : selectedProfile
                  ? selectedProfile.description
                  : 'Use generic parsing (backward-compatible default).'}
            </span>
            {selectedProfile && (
              <div
                style={{
                  marginTop: '8px',
                  padding: '10px 12px',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  background: 'var(--bg-tertiary)',
                }}
              >
                <div style={{ fontSize: '0.82rem', marginBottom: '6px' }}>
                  <strong>Under the hood</strong>
                </div>
                <ul style={{ margin: '0 0 8px 18px', padding: 0, fontSize: '0.82rem' }}>
                  {selectedProfile.under_the_hood.map((line, idx) => (
                    <li key={`uth-${idx}`}>{line}</li>
                  ))}
                </ul>
                <div style={{ fontSize: '0.82rem', marginBottom: '6px' }}>
                  <strong>What changes in result</strong>
                </div>
                <ul style={{ margin: '0 0 8px 18px', padding: 0, fontSize: '0.82rem' }}>
                  {selectedProfile.result_changes.map((line, idx) => (
                    <li key={`chg-${idx}`}>{line}</li>
                  ))}
                </ul>
                <span className="field-hint" style={{ display: 'block' }}>
                  Multiline mode: <code>{selectedProfile.multiline_mode}</code>
                  {selectedProfile.extracted_fields.length > 0 && (
                    <> | Extracted fields: <code>{selectedProfile.extracted_fields.join(', ')}</code></>
                  )}
                </span>
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
