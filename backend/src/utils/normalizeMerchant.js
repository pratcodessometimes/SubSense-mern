const CATEGORY_KEYWORDS = [
  { category: 'Streaming', keywords: ['netflix', 'prime video', 'hotstar', 'disney', 'hulu', 'sonyliv', 'zee5', 'jiocinema', 'youtube premium'] },
  { category: 'Music', keywords: ['spotify', 'apple music', 'gaana', 'wynk', 'jiosaavn', 'soundcloud'] },
  { category: 'Cloud', keywords: ['google one', 'google drive', 'dropbox', 'onedrive', 'icloud', 'aws', 'amazon web services', 'azure', 'gcp', 'digitalocean'] },
  { category: 'Software', keywords: ['adobe', 'figma', 'canva', 'microsoft 365', 'office 365', 'notion', 'slack', 'zoom', 'github', 'jetbrains'] },
  { category: 'SaaS', keywords: ['chatgpt', 'openai', 'claude', 'anthropic', 'notion', 'linear', 'asana', 'trello'] },
  { category: 'Fitness', keywords: ['cult.fit', 'cultfit', 'gold\'s gym', 'goldsgym', 'fitbit', 'strava', 'gym'] },
  { category: 'News', keywords: ['times prime', 'nyt', 'new york times', 'economist', 'medium'] },
]

const NOISE_WORDS = ['payment', 'txn', 'subscription', 'recurring', 'autopay', 'auto pay', 'bill', 'charge', 'debit', 'credit', 'pvt', 'ltd', 'inc', 'llc', 'india', 'com']

export function normalizeMerchantKey(rawMerchant) {
  let key = String(rawMerchant || '').toLowerCase()
  key = key.replace(/[^a-z0-9\s]/g, ' ')
  key = key.replace(/\d+/g, ' ')
  for (const word of NOISE_WORDS) {
    key = key.replace(new RegExp(`\\b${word}\\b`, 'g'), ' ')
  }
  key = key.replace(/\s+/g, ' ').trim()
  return key ? key.replace(/\s+/g, '-') : 'unknown'
}

export function titleCaseMerchant(rawMerchant) {
  const cleaned = String(rawMerchant || '').replace(/\s+/g, ' ').trim()
  return cleaned
    .split(' ')
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ')
}

export function categorizeMerchant(rawMerchant) {
  const lower = String(rawMerchant || '').toLowerCase()
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => lower.includes(kw))) return category
  }
  return 'Other'
}
