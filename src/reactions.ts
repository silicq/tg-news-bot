import { getState, setState } from './state';
import { titleTokens } from './similarity';
import { sendMessage } from './telegram';
import type { Config, Env, FeedItem, TelegramReactionCount } from './types';
import { logErr, utcDay } from './util';

/** How many days of reactions feed the preference signal. */
const WINDOW_DAYS = 14;

/** Remember a published message so we can attribute its reactions to a topic. */
export async function recordPost(env: Env, messageId: number, item: FeedItem): Promise<void> {
  try {
    const tokens = [...titleTokens(item.title)].join(' ');
    await env.DB.prepare(
      'INSERT OR REPLACE INTO reactions (message_id, day, tokens, likes, dislikes) VALUES (?, ?, ?, 0, 0)',
    )
      .bind(messageId, utcDay(), tokens)
      .run();
  } catch (e) {
    logErr('recordPost (reactions) failed:', String(e));
  }
}

/** Update the 👍/👎 tally for one of our posts from a reaction-count update. */
export async function applyReactionCount(env: Env, rc: TelegramReactionCount): Promise<void> {
  let likes = 0;
  let dislikes = 0;
  for (const r of rc.reactions ?? []) {
    if (r.type?.type !== 'emoji') continue;
    if (r.type.emoji === '👍') likes = r.total_count;
    else if (r.type.emoji === '👎') dislikes = r.total_count;
  }
  try {
    // Only affects rows we created (our channel posts); no-op otherwise.
    await env.DB.prepare('UPDATE reactions SET likes = ?, dislikes = ? WHERE message_id = ?')
      .bind(likes, dislikes, rc.message_id)
      .run();
  } catch (e) {
    logErr('applyReactionCount failed:', String(e));
  }
}

/**
 * Daily review (run near end of UTC day): aggregate which topics the audience
 * reacted well/badly to and store a compact preference string that the ranker
 * folds into its prompt. Also prunes old reaction rows. Notifies the admin.
 */
export async function reviewReactions(env: Env, cfg: Config): Promise<void> {
  const db = env.DB;
  const cutoff = utcDay(new Date(Date.now() - WINDOW_DAYS * 86_400_000));
  try {
    await db.prepare('DELETE FROM reactions WHERE day < ?').bind(cutoff).run();
  } catch (e) {
    logErr('reactions prune failed:', String(e));
  }

  const rows = await db
    .prepare('SELECT tokens, likes, dislikes FROM reactions')
    .all<{ tokens: string; likes: number; dislikes: number }>();

  const score = new Map<string, number>();
  let engaged = 0;
  for (const row of rows.results ?? []) {
    const net = (row.likes ?? 0) - (row.dislikes ?? 0);
    if (net === 0) continue;
    engaged++;
    for (const tok of (row.tokens ?? '').split(' ').filter(Boolean)) {
      score.set(tok, (score.get(tok) ?? 0) + net);
    }
  }

  const entries = [...score.entries()];
  const liked = entries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  const disliked = entries.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 8).map(([k]) => k);

  const pref =
    liked.length || disliked.length
      ? `Audience reaction signal (nudge scores, but the channel theme still comes first). ` +
        `Readers react POSITIVELY to stories about: ${liked.join(', ') || '—'}. ` +
        `They react NEGATIVELY to: ${disliked.join(', ') || '—'}.`
      : '';

  await setState(db, 'learned_prefs', pref);

  if (env.ADMIN_ID) {
    const summary =
      `🧠 <b>Разбор реакций за сутки</b>\n` +
      `Постов с реакциями: ${engaged}\n` +
      `👍 Заходит: ${liked.length ? liked.join(', ') : '—'}\n` +
      `👎 Не заходит: ${disliked.length ? disliked.join(', ') : '—'}\n` +
      `Сигнал учтён в отборе новостей на завтра.`;
    await sendMessage(env, env.ADMIN_ID, summary).catch(() => {});
  }
}

/** The learned-preference string to inject into the ranking prompt (or ''). */
export async function learnedPrefs(env: Env): Promise<string> {
  return (await getState(env.DB, 'learned_prefs')) ?? '';
}
