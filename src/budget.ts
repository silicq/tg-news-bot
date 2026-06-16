import type { Config } from './types';
import { utcDay } from './util';

export interface DailyUsage {
  neurons: number;
  posts: number;
}

/** Read today's neuron spend + post count from D1. */
export async function loadDailyUsage(db: D1Database, day: string): Promise<DailyUsage> {
  const row = await db
    .prepare('SELECT neurons_used, posts_count FROM budget WHERE day = ?')
    .bind(day)
    .first<{ neurons_used: number; posts_count: number }>();
  return { neurons: row?.neurons_used ?? 0, posts: row?.posts_count ?? 0 };
}

/** Increment today's counters (UPSERT). */
export async function saveDailyUsage(
  db: D1Database,
  day: string,
  neuronsDelta: number,
  postsDelta: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO budget (day, neurons_used, posts_count)
       VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         neurons_used = neurons_used + excluded.neurons_used,
         posts_count  = posts_count  + excluded.posts_count`,
    )
    .bind(day, Math.round(neuronsDelta), Math.round(postsDelta))
    .run();
}

/**
 * Tracks neuron spend and post count for the current run, guards against
 * exceeding the daily budget, and flushes deltas to D1.
 *
 * NOTE: Workers AI does not report real neuron usage in the binding response,
 * so every `spend()` uses a deliberately-generous estimate (see config.est.*).
 * Being generous means the guard trips early rather than overshooting the
 * 10,000/day free-tier ceiling.
 */
export class BudgetTracker {
  spentThisRun = 0;
  postsThisRun = 0;
  private savedNeurons = 0;
  private savedPosts = 0;

  constructor(
    private readonly db: D1Database,
    private readonly day: string,
    private readonly startNeurons: number,
    private readonly startPosts: number,
    private readonly cfg: Config,
  ) {}

  /** Neurons left in today's budget. */
  remaining(): number {
    return this.cfg.dailyNeuronBudget - (this.startNeurons + this.spentThisRun);
  }

  /** Would spending `n` more neurons stay within budget? */
  canAfford(n: number): boolean {
    return this.startNeurons + this.spentThisRun + n <= this.cfg.dailyNeuronBudget;
  }

  /** True when remaining budget is below the og-fallback threshold. */
  isLow(): boolean {
    return this.remaining() < this.cfg.ogFallbackThreshold;
  }

  /** Total posts published today (persisted + this run). */
  totalPosts(): number {
    return this.startPosts + this.postsThisRun;
  }

  spend(n: number): void {
    this.spentThisRun += n;
  }

  countPost(): void {
    this.postsThisRun += 1;
  }

  /** Persist any not-yet-saved deltas to D1. Safe to call repeatedly. */
  async flush(): Promise<void> {
    const dN = this.spentThisRun - this.savedNeurons;
    const dP = this.postsThisRun - this.savedPosts;
    if (dN === 0 && dP === 0) return;
    await saveDailyUsage(this.db, this.day, dN, dP);
    this.savedNeurons = this.spentThisRun;
    this.savedPosts = this.postsThisRun;
  }
}

/** Build a tracker seeded with today's persisted usage. */
export async function createTracker(db: D1Database, cfg: Config): Promise<BudgetTracker> {
  const day = utcDay();
  const usage = await loadDailyUsage(db, day);
  return new BudgetTracker(db, day, usage.neurons, usage.posts, cfg);
}
