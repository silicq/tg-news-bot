import type { Config } from './types';

/** Local hour (0-23) in the audience timezone. */
export function localHour(cfg: Config, now: Date = new Date()): number {
  return (((now.getUTCHours() + cfg.tzOffsetHours) % 24) + 24) % 24;
}

/** No posting when start <= local hour < end (audience timezone). */
export function isQuietHours(cfg: Config, now: Date = new Date()): boolean {
  if (cfg.quietStartHour === cfg.quietEndHour) return false; // disabled
  const hour = localHour(cfg, now);
  return cfg.quietStartHour < cfg.quietEndHour
    ? hour >= cfg.quietStartHour && hour < cfg.quietEndHour
    : hour >= cfg.quietStartHour || hour < cfg.quietEndHour; // wraps midnight
}
