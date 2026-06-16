// Failure alerting for the autonomous bot. After each cron run we classify the
// outcome and DM the admin when something looks broken (run crashed, RSS dry,
// or the channel rejects every post), with throttling and a "recovered" notice.

import { sendMessage } from './telegram';
import { getState, getStateNum, setState } from './state';
import type { Config, Env } from './types';
import { escapeHtml, log, logErr, truncate } from './util';

export interface RunOutcome {
  fetched: number; // fresh items pulled from RSS
  posted: number; // successfully published
  postAttempts: number; // sends attempted (posted + failed)
  postFailures: number; // sends that threw
  error?: string; // set if the run itself crashed
}

const KEY_EMPTY_STREAK = 'health_empty_streak';
const KEY_DEGRADED = 'health_degraded';
const KEY_LAST_ALERT = 'health_last_alert';

/**
 * Inspect a finished run and alert the admin if needed. Best-effort: never
 * throws (so it can't break the run), and still sends the Telegram alert even
 * if D1 state is unavailable.
 */
export async function runHealthCheck(env: Env, cfg: Config, outcome: RunOutcome): Promise<void> {
  if (!cfg.healthAlerts || !env.ADMIN_ID) return;
  const db = env.DB;

  try {
    // --- empty-streak bookkeeping (consecutive runs with zero fresh items) ---
    let emptyStreak = await getStateNum(db, KEY_EMPTY_STREAK, 0);
    emptyStreak = outcome.fetched === 0 ? emptyStreak + 1 : 0;
    await setState(db, KEY_EMPTY_STREAK, emptyStreak);

    // --- decide whether something is wrong ---
    const allPostsFailed = outcome.postAttempts > 0 && outcome.postFailures === outcome.postAttempts;
    let alert: string | null = null;
    if (outcome.error) {
      alert =
        '❌ <b>Сбой автопостинга</b>\nЗапуск упал с ошибкой:\n<code>' +
        escapeHtml(truncate(outcome.error, 600)) +
        '</code>';
    } else if (allPostsFailed) {
      alert =
        `❌ <b>Не удаётся публиковать в канал</b>\nВсе ${outcome.postAttempts} попыток публикации упали. ` +
        'Проверь, что бот — админ канала с правом публикации и что токен жив.';
    } else if (emptyStreak >= cfg.healthEmptyStreak) {
      alert =
        `⚠️ <b>Нет новостей</b>\nУже ${emptyStreak} запуск(ов) подряд RSS не вернул ни одной свежей новости. ` +
        'Проверь RSS_FEEDS и MAX_AGE_HOURS.';
    }

    const degraded = (await getState(db, KEY_DEGRADED)) === '1';

    if (alert) {
      const now = Date.now();
      const lastAlert = await getStateNum(db, KEY_LAST_ALERT, 0);
      const cooldownMs = cfg.healthCooldownHours * 3_600_000;
      // Alert on the first bad run of a streak, then at most once per cooldown.
      if (!degraded || now - lastAlert >= cooldownMs) {
        await notify(env, alert);
        await setState(db, KEY_LAST_ALERT, now);
      }
      await setState(db, KEY_DEGRADED, '1');
    } else if (degraded) {
      // Healthy run after a bad streak — announce recovery once.
      await notify(env, '✅ <b>Восстановлено</b>\nАвтопостинг снова работает нормально.');
      await setState(db, KEY_DEGRADED, '0');
    }
  } catch (e) {
    logErr('health check error:', String(e));
  }
}

async function notify(env: Env, message: string): Promise<void> {
  try {
    await sendMessage(env, env.ADMIN_ID!, message);
    log('health alert sent to admin');
  } catch (e) {
    logErr('failed to send health alert:', String(e));
  }
}
