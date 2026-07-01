import type { FeedItem } from './types';

// Category inferred from the (English) headline+summary by keyword — free,
// deterministic, no neurons. First rubric to match wins; order = priority.
const RUBRICS: Array<{ label: string; words: string[] }> = [
  {
    label: '🌌 Космос',
    words: ['space', 'nasa', 'mars', 'moon', 'lunar', 'rover', 'galax', 'planet', 'asteroid', 'comet', 'astronaut', 'rocket', 'orbit', 'telescope', 'cosmic', 'spacecraft', 'meteor', 'nebula', 'exoplanet'],
  },
  {
    label: '🐾 Животные',
    words: ['animal', 'wildlife', 'whale', 'dolphin', 'dog', 'puppy', 'cat', 'kitten', 'panda', 'elephant', 'lion', 'tiger', 'bird', 'penguin', 'turtle', 'frog', 'shark', 'octopus', 'rhino', 'giraffe', 'koala', 'wolf', 'bear', 'fox', 'deer', 'horse', 'monkey', 'gorilla', 'reptile', 'insect', 'butterfly', 'species'],
  },
  {
    label: '🌿 Природа',
    words: ['forest', 'ocean', 'coral', 'reef', 'river', 'climate', 'nature', 'plant', 'tree', 'garden', 'conservation', 'ecosystem', 'glacier', 'volcano', 'weather', 'mountain', 'desert'],
  },
  {
    label: '🎨 Дизайн/Арт',
    words: ['artist', 'design', 'mural', 'sculpture', 'painting', 'photograph', 'architect', 'museum', 'exhibit', 'installation', 'illustration', 'art'],
  },
  {
    label: '🏛 История',
    words: ['ancient', 'history', 'historic', 'archaeolog', 'archeolog', 'fossil', 'excavat', 'ruins', 'artifact', 'tomb', 'medieval', 'roman', 'egypt', 'etruscan', 'prehistoric', 'dinosaur', 'neanderthal', 'hominin', 'viking', 'castle', 'mummy'],
  },
  {
    label: '🔬 Наука',
    words: ['scien', 'research', 'study', 'studies', 'discover', 'physics', 'chemist', 'biolog', 'genetic', 'genome', 'quantum', 'experiment', 'breakthrough', 'neuroscience', 'microb'],
  },
  {
    label: '💡 Технологии',
    words: ['technolog', 'robot', 'artificial intelligence', 'engineer', 'invent', 'gadget', 'batter', 'solar panel', 'drone', 'microchip'],
  },
  {
    label: '😊 Позитив',
    words: ['good news', 'kindness', 'rescue', 'reunit', 'volunteer', 'donat', 'charity', 'heartwarming', 'inspir'],
  },
];

const DEFAULT_LABEL = '✨ Интересное';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Long keywords (>=5 chars) match as a prefix ("scien" -> "science"); short ones
// match as a whole word with an optional plural ("dog"/"dogs", but not "dogma").
function buildMatcher(words: string[]): RegExp {
  const parts = words.map((w) => (w.length >= 5 ? `${escapeRe(w)}[a-z]*` : `${escapeRe(w)}s?`));
  return new RegExp(`\\b(?:${parts.join('|')})\\b`, 'i');
}

const MATCHERS = RUBRICS.map((r) => ({ label: r.label, re: buildMatcher(r.words) }));

/** Rubric label for an item (based on title + description). */
export function rubricFor(item: FeedItem): string {
  const text = `${item.title} ${item.description ?? ''}`;
  for (const r of MATCHERS) {
    if (r.re.test(text)) return r.label;
  }
  return DEFAULT_LABEL;
}
