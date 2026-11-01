import { one, type Tx } from '../db/pool.js';

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  /** QMC-02: configurable mask; {PORT} {YYYY} {SEQ:n} */
  'reference.mask': 'NAM-{PORT}-{YYYY}-{SEQ:6}',
  'finding.reference.mask': 'FND-{YYYY}-{SEQ:4}',
  /** Days a resolved case waits for dispute before closing automatically. */
  'workflow.review_window_days': 5,
  'dedup.similarity_threshold': 0.55,
  'dedup.lookback_days': 30,
  'classifier.auto_accept_confidence': 0.85,
  'filter.classifier_threshold': 0.8,
  'assist.confidence_threshold': 0.32,
  'assist.max_turns_before_handover': 8,
  'satisfaction.followup_max_score': 2,
  'threshold.backlog_max': 150,
  'threshold.breach_rate_max_percent': 10,
  'portal.registration_requires_approval': true,
};

export async function getSetting<T = any>(tx: Tx, key: string): Promise<T> {
  const row = await one<{ value: T }>(tx, 'SELECT value FROM settings WHERE key = $1', [key]);
  return (row ? row.value : DEFAULT_SETTINGS[key]) as T;
}

export async function setSetting(tx: Tx, key: string, value: unknown) {
  await tx.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
