import { localTimestamp } from '../../config/index.js';
import { logger } from '../../config/logger.js';
import type { getDb } from '../../db/index.js';
import { recalcEffectiveScores } from './recalcScores.js';

type Db = ReturnType<typeof getDb>;

interface QueueState {
  running: boolean;
  pending: boolean;
  /**
   * True means all currently queued requests can skip the expensive
   * normal-behavior regex scan. If any caller requests full mode,
   * this is flipped to false for the next run.
   */
  skipNormalBehavior: boolean;
}

const stateByScope = new Map<string, QueueState>();

function scopeKey(systemId: string | null): string {
  return systemId ?? '*';
}

/**
 * Queue a recalculation for a system (or all systems when null), coalescing
 * bursts into as few runs as possible.
 *
 * This keeps request handlers fast while still guaranteeing eventual score
 * convergence.
 */
export function queueEffectiveScoreRecalc(
  db: Db,
  systemId: string | null,
  options?: { skipNormalBehavior?: boolean },
): void {
  const key = scopeKey(systemId);
  const skip = options?.skipNormalBehavior ?? true;

  let state = stateByScope.get(key);
  if (!state) {
    state = { running: false, pending: false, skipNormalBehavior: true };
    stateByScope.set(key, state);
  }

  // Coalesce: a single pending flag is enough to represent any burst.
  state.pending = true;
  // If any caller requests full mode, preserve it for the next run.
  if (!skip) state.skipNormalBehavior = false;

  if (!state.running) {
    startWorker(db, systemId, key);
  }
}

function startWorker(db: Db, systemId: string | null, key: string): void {
  const state = stateByScope.get(key);
  if (!state || state.running) return;
  state.running = true;

  setImmediate(async () => {
    while (true) {
      const current = stateByScope.get(key);
      if (!current) return;

      // Consume one coalesced batch.
      current.pending = false;
      const skip = current.skipNormalBehavior;
      current.skipNormalBehavior = true;

      try {
        const updated = await recalcEffectiveScores(db, systemId, { skipNormalBehavior: skip });
        logger.debug(
          `[${localTimestamp()}] Recalc queue: ${updated} windows updated (system=${systemId ?? 'all'}, skipNormalBehavior=${skip})`,
        );
      } catch (err: any) {
        logger.error(
          `[${localTimestamp()}] Recalc queue failed (system=${systemId ?? 'all'}): ${err?.message ?? String(err)}`,
        );
      }

      // If no new requests arrived during execution, stop worker.
      if (!current.pending) {
        current.running = false;
        // Clean up idle state to avoid unbounded map growth.
        if (!current.pending && current.skipNormalBehavior) {
          stateByScope.delete(key);
        }
        return;
      }
    }
  });
}
