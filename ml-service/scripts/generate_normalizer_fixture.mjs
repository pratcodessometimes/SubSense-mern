// Generates tests/fixtures/normalizer_parity.json by running the REAL
// backend JavaScript normalizer. The Python port is tested against it.
//
//   node scripts/generate_normalizer_fixture.mjs      (run from ml-service/)
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const normalizerPath = join(here, '..', '..', 'backend', 'src', 'services', 'merchantNormalizer.js')
const { normalizeMerchant } = await import(pathToFileURL(normalizerPath).href)

const inputs = [
  // sample-transactions.csv
  'POS DEBIT - NETFLIX.COM* 1234', 'UPI/SPOTIFY AB/4028', 'AMAZON WEB SERVICES',
  'ADOBE *CREATIVE CLOUD', 'SWIGGY BANGALORE', 'UBER TRIP MUMBAI', 'STARBUCKS COFFEE', 'BLINKIT COMMERCE',
  // backend/tests/detection.test.js
  'UPI/Spotify AB/Ref#4028', 'ACH DEBIT - AMAZON WEB SERVICES', 'ADOBE *CREATIVE CLOUD LLC',
  'OPENAI *CHATGPT SUBSCRIPTION', 'UPI/SWIGGY FOOD DELIVERY', 'STARBUCKS COFFEE INDIA PVT LTD',
  // synthetic templates
  'FIGMA MONTHLY 4821', 'GOOGLE *YOUTUBE PREMIUM', 'APPLE MUSIC SUBSCRIPTION', 'SLACK TECHNOLOGIES 9921',
  'ZOOM.US 888-799', 'CURSOR AI IDE', 'GITHUB *COPILOT', 'DISNEY+ HOTSTAR 1234', 'VERCEL INC',
  'NOTION LABS INC', 'CULT.FIT MEMBERSHIP', 'UPI/KINDLEVERSE READS/5531', 'AUTOPAY STREAMBOX PLUS',
  'AMAZON PRIME ANNUAL', 'DROPBOX PLUS ANNUAL', 'GOOGLE ONE 2TB YEARLY', 'APPLE.COM/BILL ICLOUD',
  'ADOBE *CREATIVE CLOUD ANNUAL', 'RAZORPAY*NEWSDAILY ANNUAL', 'UBER TRIP 7712', 'ZOMATO ORDER',
  'BIGBASKET 3301', 'POS PURCHASE - CROSSWORD BOOKS', 'PVR CINEMAS', 'INDIAN OIL PETROL PUMP',
  'DMART READY', 'MSEDCL ELECTRICITY BILL', 'MAHANAGAR GAS LTD', 'BWSSB WATER CHARGES',
  'TATA POWER ELECTRICITY', 'NEFT RENT TO LANDLORD', 'IMPS HOUSE RENT', 'BAJAJ FINSERV EMI',
  'HOME CREDIT EMI', 'PIXELPLAY GAMES', 'SKILLHUB COURSES', 'MEDITATE APP', 'LOCAL GYM KIOSK',
  'CLOUDKITCHEN MEALPASS', 'PARKING WALLET TOPUP',
  // edge cases
  '', '   ', 'UPI/ACME GYM PVT LTD/123456', 'ACH DEBIT - ACME CORP', 'www.example.com',
  'random store #9871', 'IN/DMART READY', 'XYZ XXXX', 'BILLDESK*MSEDCL', 'a', '---',
  '  multiple   spaces   shop  ', 'NACH/LIC PREMIUM/0099', 'payment to joes pizza',
]

const cases = inputs.map((input) => ({ input, expected: normalizeMerchant(input) }))
cases.push({ input: null, expected: normalizeMerchant(null) })

const out = join(here, '..', 'tests', 'fixtures', 'normalizer_parity.json')
writeFileSync(out, JSON.stringify({ generatedFrom: 'backend/src/services/merchantNormalizer.js', cases }, null, 2) + '\n')
console.log(`wrote ${cases.length} cases to ${out}`)
