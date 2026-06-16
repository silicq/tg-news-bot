import type { Config } from './types';
import { utcDay } from './util';

export interface DailyUsage {
  neurons: number;
  posts: number;
  skipped: number;
}

/** Read today's neuron spend, post count and skipped count from D1. */
export async function loadDailyUsage(db: D1Database, day: string): Promise<DailyUsage> {
  const row = await db
    .prepare('SELECT neurons_used, posts_count, skipped_count FROM budget WHERE day = ?')
    .bind(day)
    .first<{ neurons_used: number; posts_count: number; skipped_count: number }>();
  return {
    neurons: row?.neurons_used ?? 0,
    posts: row?.posts_count ?? 0,
    skipped: row?.skipped_count ?? 0,
  };
}

/** Increment today's counters (UPSERT). */
export async function saveDailyUsage(
  db: D1Database,
  day: string,
  neuronsDelta: number,
  postsDelta: number,
  skippedDelta = 0,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO budget (day, neurons_used, posts_count, skipped_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         neurons_used  = neurons_used  + excluded.neurons_used,
         posts_count   = posts_count   + excluded.posts_count,
         skipped_count = skipped_count + excluded.skipped_count`,
    )
    .bind(day, Math.round(neuronsDelta), Math.round(postsDelta), Math.round(skippedDelta))
    .run();
}

/**
 * Tracks neuron spend, post count and skipped count for the current run,
 * guards against exceeding the daily budget, and flushes deltas to D1.
 *
 * NOTE: Workers AI does not report real neuron usage in the binding response,
 * so every `spend()` uses a deliberately-generous estimate (see config.est.*).
 * Being generous means the guard trips early rather than overshooting the
 * 10,000/day free-tier ceiling.
 */
export class BudgetTracker {
  spentThisRun = 0;
  postsThisRun = 0;
  skippedThisRun = 0;
  private savedNeurons = 0;
  private savedPosts = 0;
  private savedSkipped = 0;

  constructor(
    private readonly db: D1Database,
    private readonly day: string,
    private readonly startNeurons: number,
    private readonly startPosts: number,
    private readonly cfg: Config,
  ) {}

  remaining(): number {
    return this.cfg.dailyNeuronBudget - (this.startNeurons + this.spentThisRun);
  }

  canAfford(n: number): boolean {
    return this.startNeurons + this.spentThisRun + n <= this.cfg.dailyNeuronBudget;
  }

  isLow(): boolean {
    return this.remaining() < this.cfg.ogFallbackThreshold;
  }

  totalPosts(): number {
    return this.startPosts + this.postsThisRun;
  }

  spend(n: number): void {
    this.spentThisRun += n;
  }

  countPost(): void {
    this.postsThisRun += 1;
  }

  countSkipped(n = 1): void {
    if (n > 0) this.skippedThisRun += n;
  }

  /** Persist any not-yet-saved deltas to D1. Safe to call repeatedly. */
  async flush(): Promise<void> {
    const dN = this.spentThisRun - this.savedNeurons;
    const dP = this.postsThisRun - this.savedPosts;
    const dS = this.skippedThisRun - this.savedSkipped;
    if (dN === 0 && dP === 0 && dS === 0) return;
    await saveDailyUsage(this.db, this.day, dN, dP, dS);
    this.savedNeurons = this.spentThisRun;
    this.savedPosts = this.postsThisRun;
    this.savedSkipped = this.skippedThisRun;
  }
}

/** Build a tracker seeded with today's persisted usage. */
export async function createTracker(db: D1Database, cfg: Config): Promise<BudgetTracker> {
  const day = utcDay();
  const usage = await loadDailyUsage(db, day);
  return new BudgetTracker(db, day, usage.neurons, usage.posts, cfg);
}
