import express from 'express';
import dotenv from 'dotenv';
import dns from 'dns';

// Force IPv4 first for DNS resolution on Windows
dns.setDefaultResultOrder('ipv4first');

// Load environment variables from .env
dotenv.config();

import { verifyWebhook, verifyWebhookSignature, handleWebhookEvent } from './controllers/webhook';
import { initScheduler, runScheduledTasks } from './services/scheduler';

const app = express();
const PORT = process.env.PORT || 3000;
const CRON_SECRET = process.env.CRON_SECRET || '';

// Body Parsing Middleware (captures the raw body so we can verify Meta's HMAC signature)
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));

// Health Check Route
app.get('/', (req, res) => {
  res.send('🤖 Baza AI Server is Running!');
});

// Meta WhatsApp Webhook Routes
app.get('/webhook', verifyWebhook);
app.post('/webhook', verifyWebhookSignature, handleWebhookEvent);

// External cron trigger — lets a scheduler (e.g. cron-job.org) both wake a sleeping
// free-tier host and run due reminders + daily digests in the same request, since
// the internal node-cron tick can't fire while the process is asleep.
app.post('/cron/check-reminders', async (req, res) => {
  if (!CRON_SECRET || req.header('x-cron-secret') !== CRON_SECRET) {
    res.sendStatus(401);
    return;
  }
  const result = await runScheduledTasks();
  res.status(200).json(result);
});

// Start Server & Background Scheduler
app.listen(PORT, () => {
  console.log(`🚀 Baza AI server running on http://localhost:${PORT}`);
  console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook`);

  // Initialize reminder cron engine
  initScheduler();
});
