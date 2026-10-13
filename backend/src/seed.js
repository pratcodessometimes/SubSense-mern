import 'dotenv/config'
import mongoose from 'mongoose'
import { connectDB } from './config/db.js'
import { Alert } from './models/Alert.js'
import { Subscription } from './models/Subscription.js'
import { Transaction } from './models/Transaction.js'

const initialSubscriptions = [
  {
    slug: 'netflix',
    name: 'Netflix',
    category: 'Streaming',
    amount: 649,
    previousAmount: 499,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-14'),
    status: 'price_increase',
    transactionCount: 8,
    confidence: 0.91,
    lastActivity: new Date('2026-08-30'),
  },
  {
    slug: 'spotify',
    name: 'Spotify',
    category: 'Music',
    amount: 119,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-08'),
    status: 'active',
    transactionCount: 11,
    confidence: 0.97,
    lastActivity: new Date('2026-08-29'),
  },
  {
    slug: 'aws',
    name: 'AWS',
    category: 'Cloud',
    amount: 820,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-05'),
    status: 'active',
    transactionCount: 6,
    confidence: 0.88,
    lastActivity: new Date('2026-08-28'),
  },
  {
    slug: 'adobe',
    name: 'Adobe Creative Cloud',
    category: 'Software',
    amount: 1675,
    previousAmount: 1495,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-18'),
    status: 'unused',
    transactionCount: 5,
    confidence: 0.82,
    lastActivity: new Date('2026-06-02'),
  },
  {
    slug: 'google-one',
    name: 'Google One',
    category: 'Cloud',
    amount: 130,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-11'),
    status: 'duplicate',
    transactionCount: 9,
    confidence: 0.94,
    lastActivity: new Date('2026-08-27'),
  },
  {
    slug: 'dropbox',
    name: 'Dropbox',
    category: 'Cloud',
    amount: 849,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-16'),
    status: 'duplicate',
    transactionCount: 7,
    confidence: 0.89,
    lastActivity: new Date('2026-08-25'),
  },
  {
    slug: 'prime',
    name: 'Amazon Prime',
    category: 'Streaming',
    amount: 299,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-20'),
    status: 'active',
    transactionCount: 4,
    confidence: 0.85,
    lastActivity: new Date('2026-08-20'),
  },
  {
    slug: 'disney',
    name: 'Disney+ Hotstar',
    category: 'Streaming',
    amount: 201,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-22'),
    status: 'active',
    transactionCount: 6,
    confidence: 0.9,
    lastActivity: new Date('2026-08-22'),
  },
  {
    slug: 'notion',
    name: 'Notion',
    category: 'SaaS',
    amount: 640,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-10'),
    status: 'active',
    transactionCount: 5,
    confidence: 0.86,
    lastActivity: new Date('2026-08-26'),
  },
  {
    slug: 'cult-fit',
    name: 'Cult.fit',
    category: 'Fitness',
    amount: 899,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-12'),
    status: 'active',
    transactionCount: 4,
    confidence: 0.83,
    lastActivity: new Date('2026-08-24'),
  },
  {
    slug: 'figma',
    name: 'Figma',
    category: 'Software',
    amount: 900,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-19'),
    status: 'active',
    transactionCount: 4,
    confidence: 0.87,
    lastActivity: new Date('2026-08-19'),
  },
  {
    slug: 'chatgpt',
    name: 'ChatGPT Plus',
    category: 'SaaS',
    amount: 1999,
    billingInterval: 'monthly',
    nextBillingDate: new Date('2026-09-06'),
    status: 'active',
    transactionCount: 3,
    confidence: 0.8,
    lastActivity: new Date('2026-08-31'),
  },
]

const initialTransactions = [
  { date: new Date('2026-08-14'), merchant: 'Netflix', amount: 649, account: 'HDFC •••• 2814', category: 'Streaming', isRecurring: true, subscriptionId: 'netflix' },
  { date: new Date('2026-08-12'), merchant: 'Swiggy', amount: 420, account: 'ICICI •••• 8211', category: 'Food', isRecurring: false },
  { date: new Date('2026-08-10'), merchant: 'Spotify', amount: 119, account: 'HDFC •••• 2814', category: 'Music', isRecurring: true, subscriptionId: 'spotify' },
  { date: new Date('2026-08-05'), merchant: 'AWS', amount: 820, account: 'ICICI •••• 8211', category: 'Cloud', isRecurring: true, subscriptionId: 'aws' },
  { date: new Date('2026-08-02'), merchant: 'Adobe Creative Cloud', amount: 1675, account: 'HDFC •••• 2814', category: 'Software', isRecurring: true, subscriptionId: 'adobe' },
  { date: new Date('2026-07-31'), merchant: 'Uber', amount: 210, account: 'ICICI •••• 8211', category: 'Transport', isRecurring: false },
  { date: new Date('2026-07-27'), merchant: 'Google One', amount: 130, account: 'HDFC •••• 2814', category: 'Cloud', isRecurring: true, subscriptionId: 'google-one' },
  { date: new Date('2026-07-25'), merchant: 'Dropbox', amount: 849, account: 'ICICI •••• 8211', category: 'Cloud', isRecurring: true, subscriptionId: 'dropbox' },
  { date: new Date('2026-07-20'), merchant: 'Amazon Prime', amount: 299, account: 'HDFC •••• 2814', category: 'Streaming', isRecurring: true, subscriptionId: 'prime' },
  { date: new Date('2026-07-18'), merchant: 'BigBasket', amount: 1120, account: 'ICICI •••• 8211', category: 'Groceries', isRecurring: false },
  { date: new Date('2026-07-14'), merchant: 'Netflix', amount: 649, account: 'HDFC •••• 2814', category: 'Streaming', isRecurring: true, subscriptionId: 'netflix' },
  { date: new Date('2026-07-10'), merchant: 'Spotify', amount: 119, account: 'HDFC •••• 2814', category: 'Music', isRecurring: true, subscriptionId: 'spotify' },
]

const initialAlerts = [
  {
    type: 'price_increase',
    severity: 'warning',
    title: 'Price increase detected',
    description: 'Your Netflix subscription increased by ₹150/month.',
    subscriptionIds: ['netflix'],
    impact: '₹1,800',
    impactLabel: 'Potential yearly impact',
  },
  {
    type: 'duplicate',
    severity: 'warning',
    title: 'Duplicate subscription detected',
    description: 'You appear to have two cloud-storage subscriptions with overlapping purpose.',
    subscriptionIds: ['google-one', 'dropbox'],
    impact: '₹979 / month',
    impactLabel: 'Potential overlap',
  },
  {
    type: 'unused',
    severity: 'critical',
    title: 'Unused subscription',
    description: 'No related activity detected recently for Adobe Creative Cloud.',
    subscriptionIds: ['adobe'],
    impact: '₹20,100',
    impactLabel: 'Estimated annual cost',
  },
]

async function seed() {
  try {
    await connectDB()
    console.log('Seeding MongoDB Atlas...')

    await Subscription.deleteMany({})
    await Transaction.deleteMany({})
    await Alert.deleteMany({})

    const insertedSubs = await Subscription.insertMany(initialSubscriptions)
    const insertedTx = await Transaction.insertMany(initialTransactions)
    const insertedAlerts = await Alert.insertMany(initialAlerts)

    console.log(`✓ Seeded ${insertedSubs.length} subscriptions into MongoDB Atlas`)
    console.log(`✓ Seeded ${insertedTx.length} transactions into MongoDB Atlas`)
    console.log(`✓ Seeded ${insertedAlerts.length} alerts into MongoDB Atlas`)

    await mongoose.disconnect()
    console.log('Seed completed successfully.')
    process.exit(0)
  } catch (err) {
    console.error('Seed failed:', err)
    process.exit(1)
  }
}

seed()
