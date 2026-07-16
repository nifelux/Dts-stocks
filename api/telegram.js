/**
 * Telegram Bot Webhook & Notification Sender
 * Handles incoming updates (commands) from Telegram.
 */
import supabaseAdmin from '../lib/supabase.js';
import { sendTelegramMessage } from '../lib/telegram.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.TELEGRAM_ADMIN_CHAT_IDS || '').split(',').map(s => s.trim());

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const update = req.body;
      if (update.message && update.message.text) {
        const chatId = update.message.chat.id.toString();
        if (!ADMIN_CHAT_IDS.includes(chatId)) {
          // Ignore non-admin messages
          return res.status(200).end();
        }
        const text = update.message.text.trim();
        const command = text.split(' ')[0].toLowerCase();

        switch (command) {
          case '/stats': return await handleStats(chatId, res);
          case '/users': return await handleUsers(chatId, res);
          case '/pending': return await handlePending(chatId, res);
          case '/deposits': return await handleDeposits(chatId, res);
          case '/withdrawals': return await handleWithdrawals(chatId, res);
          case '/broadcast': return await handleBroadcast(chatId, text, res);
          case '/help': return await handleHelp(chatId, res);
          default: 
            await sendToTelegram(chatId, 'Unknown command. Use /help');
            return res.status(200).end();
        }
      }
      return res.status(200).end();
    } catch (err) {
      console.error('Telegram webhook error:', err);
      return res.status(500).end();
    }
  } else {
    // For webhook setup GET request
    return res.status(200).json({ message: 'Telegram webhook endpoint' });
  }
}

async function sendToTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

async function handleStats(chatId, res) {
  const [users, deposits, withdrawals] = await Promise.all([
    supabaseAdmin.from('profiles').select('id', { count: 'exact' }),
    supabaseAdmin.from('deposits').select('amount').eq('status', 'approved'),
    supabaseAdmin.from('withdrawals').select('amount').eq('status', 'approved')
  ]);
  const totalDep = deposits.data.reduce((s,d)=>s+d.amount,0);
  const totalWith = withdrawals.data.reduce((s,w)=>s+w.amount,0);
  const msg = `<b>📊 Platform Stats</b>\n👥 Users: ${users.count}\n💰 Approved Deposits: ₦${totalDep.toLocaleString()}\n💸 Approved Withdrawals: ₦${totalWith.toLocaleString()}`;
  await sendToTelegram(chatId, msg);
  res.status(200).end();
}

async function handleUsers(chatId, res) {
  const { data } = await supabaseAdmin.from('profiles').select('email, created_at').order('created_at', { ascending: false }).limit(10);
  const list = data.map(u => `• ${u.email} (${new Date(u.created_at).toLocaleDateString()})`).join('\n');
  await sendToTelegram(chatId, `<b>Recent Users:</b>\n${list || 'None'}`);
  res.status(200).end();
}

async function handlePending(chatId, res) {
  const [dep, wit] = await Promise.all([
    supabaseAdmin.from('deposits').select('amount, user_id').eq('status', 'pending'),
    supabaseAdmin.from('withdrawals').select('amount, user_id').eq('status', 'pending')
  ]);
  const msg = `⏳ <b>Pending Actions</b>\nDeposits: ${dep.data.length} (₦${dep.data.reduce((s,d)=>s+d.amount,0).toLocaleString()})\nWithdrawals: ${wit.data.length} (₦${wit.data.reduce((s,w)=>s+w.amount,0).toLocaleString()})`;
  await sendToTelegram(chatId, msg);
  res.status(200).end();
}

async function handleDeposits(chatId, res) {
  const { data } = await supabaseAdmin.from('deposits').select('*').eq('status', 'pending').limit(5);
  const list = data.map(d => `#${d.id.slice(0,8)} ₦${d.amount} (User: ${d.user_id.slice(0,8)})`).join('\n');
  await sendToTelegram(chatId, `<b>Pending Deposits:</b>\n${list || 'None'}`);
  res.status(200).end();
}

async function handleWithdrawals(chatId, res) {
  const { data } = await supabaseAdmin.from('withdrawals').select('*').eq('status', 'pending').limit(5);
  const list = data.map(w => `#${w.id.slice(0,8)} ₦${w.amount} (User: ${w.user_id.slice(0,8)})`).join('\n');
  await sendToTelegram(chatId, `<b>Pending Withdrawals:</b>\n${list || 'None'}`);
  res.status(200).end();
}

async function handleBroadcast(chatId, text, res) {
  const msgText = text.replace('/broadcast', '').trim();
  if (!msgText) {
    await sendToTelegram(chatId, 'Usage: /broadcast <message>');
    return res.status(200).end();
  }
  const { data: users } = await supabaseAdmin.from('profiles').select('id');
  const notifications = users.map(u => ({ user_id: u.id, title: 'Admin Broadcast', body: msgText }));
  await supabaseAdmin.from('notifications').insert(notifications);
  await sendToTelegram(chatId, `✅ Broadcast sent to ${users.length} users.`);
  res.status(200).end();
}

async function handleHelp(chatId, res) {
  const msg = `<b>Admin Commands:</b>
/stats - Platform statistics
/users - Recent 10 users
/pending - Pending deposits/withdrawals
/deposits - Pending deposits
/withdrawals - Pending withdrawals
/broadcast &lt;msg&gt; - Send message to all users
/help - Show this help`;
  await sendToTelegram(chatId, msg);
  res.status(200).end();
    }
