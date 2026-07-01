import { createTracker, loadDailyUsage, saveDailyUsage } from './budget';
import { buildBody, buildButtons, buildCaption, buildMessage, makeCaption } from './caption';
import { countPosted } from './dedup';
import { fetchAllFeeds } from './feeds';
import { applyWatermark, fetchOgImage, generateImage, makeImagePrompt } from './image';
import { isQuietHours, localHour } from './schedule';
import { publishTranslatedArticle } from './telegraph';
import {
  getChat,
  getChatMember,
  getMe,
  sendMessage,
  sendPhoto,
} from './telegram';
import type { Config, Env } from './types';
import { escapeHtml, logErr, utcDay } from './util';

const FREE_TIER_NEURONS = 10_000;

/** Text shown for /start and /help. */
export function helpText(): string {
  return [
    '<b>Команды бота</b>',
    '',
    '/test — самопроверка: пришлёт тестовый пост (фото + подпись) сюда в личку и проверит связь с каналом.',
    '/stats — статистика за сутки: опубликовано, пропущено, расход нейронов и лимиты Cloudflare.',
    '/settings — панель настроек: всё меняется прямо из Telegram, без кода и Cloudflare.',
    '/run — выполнить обычный цикл публикации прямо сейчас.',
    '/help — это сообщение.',
  ].join('\n');
}

/**
 * /test — end-to-end health check.
 * 1) тянет свежую новость и прогоняет весь конвейер (подпись + картинка),
 *    результат шлёт админу в личку;
 * 2) проверяет связь с каналом (доступ + права бота на публикацию);
 * 3) присылает админу сводку; при любой ошибке — уведомление с текстом ошибки.
 */
export async function handleTest(env: Env, cfg: Config): Promise<void> {
  const admin = env.ADMIN_ID!;
  const steps: string[] = [];
  // Local neuron accounting so the manual test still shows up in /stats.
  let spent = 0;

  try {
    await sendMessage(env, admin, '🧪 Запускаю самопроверку…');

    // --- 1. RSS ---
    const items = await fetchAllFeeds(cfg);
    if (items.length === 0) {
      await sendMessage(env, admin, '❌ Не удалось получить ни одной свежей новости из RSS. Проверь RSS_FEEDS / MAX_AGE_HOURS.');
      return;
    }
    steps.push(`RSS: получено ${items.length} свежих новостей`);
    const item = items[0]; // самая свежая

    // --- 2. Подпись (текстовая модель) ---
    let captionBody: string;
    try {
      captionBody = await makeCaption(env, cfg, item);
      spent += cfg.est.caption;
      steps.push('Текстовая модель (подпись): OK');
    } catch (e) {
      captionBody = escapeHtml(item.title);
      steps.push('⚠️ Подпись через AI не удалась, использую заголовок: ' + String(e));
    }

    // --- 3. Картинка (image-модель), с фолбэком на og:image ---
    let photo: Uint8Array | string | null = null;
    try {
      const prompt = await makeImagePrompt(env, cfg, item);
      spent += cfg.est.imagePrompt;
      photo = await generateImage(env, cfg, cfg.imageModel, prompt, cfg.imageSteps);
      spent += cfg.est.image;
      steps.push(`Image-модель (${cfg.imageModel}): OK`);
    } catch (e) {
      steps.push('⚠️ Генерация картинки не удалась: ' + String(e));
      const og = await fetchOgImage(item.link);
      if (og) {
        photo = og;
        steps.push('↪️ Использую og:image со страницы статьи');
      }
    }

    // --- 4. Telegraph-статья с переводом (если включено) ---
    let articleUrl: string | null = null;
    if (cfg.telegraphEnabled) {
      const tracker = await createTracker(env.DB, cfg);
      const article = await publishTranslatedArticle(env, cfg, item, tracker);
      articleUrl = article?.url ?? null;
      spent += tracker.spentThisRun;
      steps.push(articleUrl ? 'Telegraph-статья с переводом: ' + articleUrl : '⚠️ Статью собрать не удалось (мало текста/недоступна)');
    }

    // --- 5. Вотермарка + отправка тестового поста админу в личку ---
    const markup = cfg.buttonsEnabled
      ? { inline_keyboard: buildButtons(item.link, cfg, articleUrl) }
      : undefined;
    const caption = cfg.buttonsEnabled
      ? buildBody(captionBody)
      : buildCaption(captionBody, item.link, cfg, articleUrl);
    if (photo) {
      if (typeof photo === 'string') {
        await sendPhoto(env, admin, photo, caption, markup);
      } else {
        const watermarked = await applyWatermark(env, cfg, photo);
        steps.push(cfg.watermarkEnabled ? 'Вотермарка @monkeydiary: наложена' : 'Вотермарка: выключена');
        await sendPhoto(env, admin, watermarked, caption, markup);
      }
    } else {
      const text = cfg.buttonsEnabled ? buildBody(captionBody) : buildMessage(captionBody, item.link, cfg, articleUrl);
      await sendMessage(env, admin, text, markup);
    }
    steps.push('Отправка тестового поста в личку: OK');

    // --- 6. Проверка связи с каналом ---
    try {
      const [chat, me] = await Promise.all([getChat(env, cfg.channelId), getMe(env)]);
      const member = await getChatMember(env, cfg.channelId, me.id);
      const canPost =
        member.status === 'creator' ||
        (member.status === 'administrator' && member.can_post_messages !== false);
      if (!canPost) {
        throw new Error(`бот в канале со статусом "${member.status}" и не может публиковать. Сделай бота админом с правом «Публикация сообщений».`);
      }
      steps.push(`Канал «${chat.title ?? cfg.channelId}»: бот ${member.status}, публикация разрешена`);
    } catch (e) {
      steps.push('❌ Связь с каналом: ' + String(e));
    }

    // Учтём потраченные на тест нейроны в дневном счётчике.
    if (spent > 0) {
      try {
        await saveDailyUsage(env.DB, utcDay(), spent, 0, 0);
      } catch (e) {
        logErr('test: failed to record neurons:', String(e));
      }
    }

    const ok = !steps.some((s) => s.startsWith('❌'));
    const header = ok ? '✅ <b>Самопроверка пройдена</b>' : '⚠️ <b>Самопроверка завершена с ошибками</b>';
    await sendMessage(env, admin, header + '\n' + steps.map((s) => '• ' + escapeHtml(s)).join('\n'));
  } catch (e) {
    // Любая необработанная ошибка → уведомление админу.
    await sendMessage(env, admin, '❌ Самопроверка упала:\n' + escapeHtml(String(e))).catch(() => {});
  }
}

/** /stats — daily counters + Cloudflare neuron budget status. */
export async function handleStats(env: Env, cfg: Config): Promise<void> {
  const admin = env.ADMIN_ID!;
  const day = utcDay();

  const usage = await loadDailyUsage(env.DB, day);
  const history = await countPosted(env.DB);

  const budgetLeft = Math.max(0, cfg.dailyNeuronBudget - usage.neurons);
  const freeLeft = Math.max(0, FREE_TIER_NEURONS - usage.neurons);
  const pct = Math.round((usage.neurons / FREE_TIER_NEURONS) * 100);

  const lines = [
    `📊 <b>Статистика за ${day} (UTC)</b>`,
    '',
    `📤 Опубликовано: <b>${usage.posts}</b> / ${cfg.maxPostsPerDay} за сутки`,
    `⏭ Пропущено новостей: <b>${usage.skipped}</b>`,
    `🗂 Всего в истории: ${history} постов`,
    '',
    `🧠 <b>Нейроны Workers AI</b> (оценка):`,
    `   израсходовано: <b>${usage.neurons}</b>`,
    `   фритир Cloudflare: ${usage.neurons} / ${FREE_TIER_NEURONS} (${pct}%), осталось ~${freeLeft}`,
    `   внутренний бюджет: ${usage.neurons} / ${cfg.dailyNeuronBudget}, осталось ~${budgetLeft}`,
    '',
    `⚙️ Режим картинок: <code>${cfg.imageMode}</code>, постов за запуск: ${cfg.maxPostsPerRun}`,
    quietLine(cfg),
    `<i>Счётчик нейронов — оценка (биндинг Workers AI не возвращает реальный расход). Сброс в 00:00 UTC.</i>`,
  ];

  await sendMessage(env, admin, lines.join('\n'));
}

function quietLine(cfg: Config): string {
  if (cfg.quietStartHour === cfg.quietEndHour) return '🕐 Тихие часы: выключены';
  const now = isQuietHours(cfg)
    ? `сейчас тихо (${localHour(cfg)}:00)`
    : `сейчас активно (${localHour(cfg)}:00)`;
  return `🕐 Тихие часы: ${cfg.quietStartHour}:00–${cfg.quietEndHour}:00 (UTC${cfg.tzOffsetHours >= 0 ? '+' : ''}${cfg.tzOffsetHours}), ${now}`;
}
