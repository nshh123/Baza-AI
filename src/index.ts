import express from 'express';
import dotenv from 'dotenv';
import dns from 'dns';

// Force IPv4 first for DNS resolution on Windows
dns.setDefaultResultOrder('ipv4first');

// Load environment variables from .env
dotenv.config();

import { verifyWebhook, verifyWebhookSignature, handleWebhookEvent } from './controllers/webhook';
import { initScheduler } from './services/scheduler';

const app = express();
const PORT = process.env.PORT || 3000;

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

// Start Server & Background Scheduler
app.listen(PORT, () => {
  console.log(`🚀 Baza AI server running on http://localhost:${PORT}`);
  console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook`);

  // Initialize reminder cron engine
  initScheduler();
});
