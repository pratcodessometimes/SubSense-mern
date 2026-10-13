/**
 * Merchant Normalization Service
 * Cleans noisy transaction merchant strings, strips transaction prefixes/suffixes,
 * and extracts canonical merchant names and suggested categories.
 */

// Known subscription / merchant dictionary for precise canonicalization
const KNOWN_MERCHANTS = [
  {
    regex: /\b(netflix)\b/i,
    canonical: 'Netflix',
    slug: 'netflix',
    category: 'Streaming',
  },
  {
    regex: /\b(spotify)\b/i,
    canonical: 'Spotify',
    slug: 'spotify',
    category: 'Music',
  },
  {
    regex: /\b(aws|amazon\s*web\s*services)\b/i,
    canonical: 'AWS',
    slug: 'aws',
    category: 'Cloud',
  },
  {
    regex: /\b(adobe|creative\s*cloud|photoshop)\b/i,
    canonical: 'Adobe Creative Cloud',
    slug: 'adobe',
    category: 'Software',
  },
  {
    regex: /\b(google\s*one|google\s*storage)\b/i,
    canonical: 'Google One',
    slug: 'google-one',
    category: 'Cloud',
  },
  {
    regex: /\b(dropbox)\b/i,
    canonical: 'Dropbox',
    slug: 'dropbox',
    category: 'Cloud',
  },
  {
    regex: /\b(prime|amazon\s*prime|prime\s*video)\b/i,
    canonical: 'Amazon Prime',
    slug: 'prime',
    category: 'Streaming',
  },
  {
    regex: /\b(disney\s*\+?\s*hotstar|hotstar)\b/i,
    canonical: 'Disney+ Hotstar',
    slug: 'disney',
    category: 'Streaming',
  },
  {
    regex: /\b(notion)\b/i,
    canonical: 'Notion',
    slug: 'notion',
    category: 'SaaS',
  },
  {
    regex: /\b(cult\.?\s*fit|cure\.?\s*fit)\b/i,
    canonical: 'Cult.fit',
    slug: 'cult-fit',
    category: 'Fitness',
  },
  {
    regex: /\b(figma)\b/i,
    canonical: 'Figma',
    slug: 'figma',
    category: 'Software',
  },
  {
    regex: /\b(chatgpt|openai)\b/i,
    canonical: 'ChatGPT Plus',
    slug: 'chatgpt',
    category: 'SaaS',
  },
  {
    regex: /\b(github\s*copilot|github)\b/i,
    canonical: 'GitHub Copilot',
    slug: 'github-copilot',
    category: 'Software',
  },
  {
    regex: /\b(cursor\s*pro|cursor|anysphere)\b/i,
    canonical: 'Cursor Pro',
    slug: 'cursor-pro',
    category: 'Software',
  },
  {
    regex: /\b(vercel)\b/i,
    canonical: 'Vercel Pro',
    slug: 'vercel-pro',
    category: 'Cloud',
  },
  {
    regex: /\b(youtube\s*premium|youtube\s*music)\b/i,
    canonical: 'YouTube Premium',
    slug: 'youtube-premium',
    category: 'Streaming',
  },
  {
    regex: /\b(apple\s*music)\b/i,
    canonical: 'Apple Music',
    slug: 'apple-music',
    category: 'Music',
  },
  {
    regex: /\b(icloud|apple\.com\/bill)\b/i,
    canonical: 'iCloud+',
    slug: 'icloud',
    category: 'Cloud',
  },
  {
    regex: /\b(slack)\b/i,
    canonical: 'Slack',
    slug: 'slack',
    category: 'SaaS',
  },
  {
    regex: /\b(zoom)\b/i,
    canonical: 'Zoom',
    slug: 'zoom',
    category: 'SaaS',
  },
  {
    regex: /\b(swiggy)\b/i,
    canonical: 'Swiggy',
    slug: 'swiggy',
    category: 'Food',
  },
  {
    regex: /\b(zomato)\b/i,
    canonical: 'Zomato',
    slug: 'zomato',
    category: 'Food',
  },
  {
    regex: /\b(uber)\b/i,
    canonical: 'Uber',
    slug: 'uber',
    category: 'Transport',
  },
  {
    regex: /\b(blinkit)\b/i,
    canonical: 'Blinkit',
    slug: 'blinkit',
    category: 'Groceries',
  },
  {
    regex: /\b(bigbasket)\b/i,
    canonical: 'BigBasket',
    slug: 'bigbasket',
    category: 'Groceries',
  },
  {
    regex: /\b(starbucks)\b/i,
    canonical: 'Starbucks',
    slug: 'starbucks',
    category: 'Food',
  },
]

// Common payment processor prefixes and noise
const PREFIX_REGEX = /^(pos\s*(?:debit|purchase)?|ach\s*(?:debit|payment)?|card\s*purchase|payment\s*to|auto[- ]?debit|autopay|standing\s*order|billdesk\*?|payu\*?|razorpay\*?|upi[/_-]+(?:cr[/_-]+)?|nach[/_-]+|in[/_-]+|www\.|https?:\/\/(?:www\.)?)\s*/i

// Suffixes and company forms
const SUFFIX_REGEX = /\s*(?:\.com|\.in|\.org|\.net|\.io|\.ai|\.app|\.co|\.tv|\.cc|\.me|\b(?:inc|llc|ltd|pvt\s*ltd|private\s*limited|limited|corp|corporation|co|services|payments?|billing|subscription|membership|digital|online|international|india|us|uk|gmbh)\b|\*|\#|\/|-)+\s*$/gi

// Trailing IDs, reference numbers, masked card numbers, e.g. *1234, #9871, 8912
const TRAILING_ID_REGEX = /\s*(?:[*#\-_:]+\s*[0-9a-zA-Z]+|\b\d{4,}\b|\bxxxx\b)\s*$/gi

/**
 * Normalizes a raw merchant name.
 * @param {string} raw
 * @returns {{ cleanName: string, canonicalKey: string, slug: string, category: string }}
 */
export function normalizeMerchant(raw) {
  if (!raw || typeof raw !== 'string') {
    return {
      cleanName: 'Unknown Merchant',
      canonicalKey: 'unknown',
      slug: 'unknown',
      category: 'General',
    }
  }

  const trimmed = raw.trim()

  // 1. Check known brand dictionary first for high-accuracy normalization
  for (const item of KNOWN_MERCHANTS) {
    if (item.regex.test(trimmed)) {
      return {
        cleanName: item.canonical,
        canonicalKey: item.slug,
        slug: item.slug,
        category: item.category,
      }
    }
  }

  // 2. Generic rule-based cleaning
  let cleaned = trimmed
  cleaned = cleaned.replace(PREFIX_REGEX, '')
  cleaned = cleaned.replace(TRAILING_ID_REGEX, '')
  cleaned = cleaned.replace(SUFFIX_REGEX, '')
  cleaned = cleaned.replace(/[*_#\/\\-]+/g, ' ')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()

  if (!cleaned) {
    cleaned = trimmed
  }

  // Title-case the generic cleaned name
  const titleCased = cleaned
    .split(' ')
    .map((word) => {
      if (word.length <= 1) return word.toUpperCase()
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')

  const canonicalKey = titleCased
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

  return {
    cleanName: titleCased,
    canonicalKey: canonicalKey || 'general',
    slug: canonicalKey || 'general',
    category: 'General',
  }
}
