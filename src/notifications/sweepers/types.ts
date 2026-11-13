export interface SweepContext {
  /** the instant this run started (the scheduler's clock — injectable in tests) */
  now: Date;
  /** low-water mark: re-examine source rows created at/after this instant */
  since: Date;
}

export interface SweepResult {
  examined: number;
  created: number;
  /** rows that threw and will be retried (the watermark does not pass them) */
  failures?: number;
  /**
   * Set only when a run stopped early (batch cap): the next run resumes here
   * instead of at now−overlap, so a long outage is drained across runs.
   */
  resumeFrom?: Date;
}

export interface SweepJob {
  key: string;
  /** minimum time between runs */
  intervalMs: number;
  /** true: uses a persisted watermark (`since`); false: full scan / slot based */
  watermarked: boolean;
  run(ctx: SweepContext): Promise<SweepResult>;
}

export const BATCH_SIZE = 200;
export const MAX_BATCHES_PER_RUN = 10;
