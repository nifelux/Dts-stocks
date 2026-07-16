/**
 * Finance API – Deposits & Withdrawals
 * Actions: createDeposit, listDeposits, approveDeposit, rejectDeposit,
 *          createWithdrawal, listWithdrawals, approveWithdrawal, rejectWithdrawal
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, verifyAdmin } from '../lib/auth.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { withdrawSchema } from '../lib/validation.js';

export default async function handler(req, res) {
  const { action } = req.query;
  try {
    switch (action) {
      case 'createDeposit': return createDeposit(req, res);
      case 'listDeposits': return listDeposits(req, res);
      case 'approveDeposit': return approveDeposit(req, res);
      case 'rejectDeposit': return rejectDeposit(req, res);
      case 'createWithdrawal': return createWithdrawal(req, res);
      case 'listWithdrawals': return listWithdrawals(req, res);
      case 'approveWithdrawal': return approveWithdrawal(req, res);
      case 'rejectWithdrawal': return rejectWithdrawal(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function createDeposit(req, res) {
  const user = await verifyUser(req);
  const { amount, payment_method, proof_image_url } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const { data, error } = await supabaseAdmin.from('deposits').insert({
    user_id: user.id, amount, payment_method, proof_image_url
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  await supabaseAdmin.from('activity_logs').insert({ user_id: user.id, action: 'deposit_request', details: { amount } });
  await sendTelegramMessage(`💰 New deposit request: ₦${amount} from ${user.email}`);
  return res.status(200).json(data);
}

async function listDeposits(req, res) {
  const user = await verifyUser(req);
  // User sees own; if admin, we'll handle in admin api. But here just own.
  const { data } = await supabaseAdmin.from('deposits').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  return res.status(200).json(data);
}

async function approveDeposit(req, res) {
  const admin = await verifyAdmin(req);
  const { deposit_id, admin_notes } = req.body;
  // Fetch deposit
  const { data: deposit } = await supabaseAdmin.from('deposits').select('*').eq('id', deposit_id).single();
  if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
  if (deposit.status !== 'pending') return res.status(400).json({ error: 'Deposit already processed' });

  // Update deposit
  await supabaseAdmin.from('deposits').update({ status: 'approved', admin_notes, updated_at: new Date() }).eq('id', deposit_id);
  // Create approved transaction (will trigger wallet credit)
  const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
    user_id: deposit.user_id,
    type: 'deposit',
    amount: deposit.amount,
    status: 'approved',
    reference: `dep_${deposit.id}`
  });
  if (txnErr) return res.status(400).json({ error: txnErr.message });

  await sendTelegramMessage(`✅ Deposit approved: ₦${deposit.amount} (${deposit.user_id})`);
  return res.status(200).json({ message: 'Deposit approved' });
}

async function rejectDeposit(req, res) {
  const admin = await verifyAdmin(req);
  const { deposit_id, admin_notes } = req.body;
  await supabaseAdmin.from('deposits').update({ status: 'rejected', admin_notes, updated_at: new Date() }).eq('id', deposit_id);
  await sendTelegramMessage(`❌ Deposit rejected: ${deposit_id}`);
  return res.status(200).json({ message: 'Deposit rejected' });
}

async function createWithdrawal(req, res) {
  const user = await verifyUser(req);
  const { amount, bank_name, account_number, account_name } = req.body;
  try { withdrawSchema.parse(req.body); } catch (e) { return res.status(400).json({ error: e.errors[0].message }); }

  // Check withdrawal settings
  const { data: settings } = await supabaseAdmin.from('settings').select('*').eq('key', 'withdrawal').single();
  const wSettings = settings?.value || {};
  if (!wSettings.enabled) return res.status(400).json({ error: 'Withdrawals disabled' });
  const now = new Date();
  const openHour = parseInt(wSettings.open_hour || 10);
  const closeHour = parseInt(wSettings.close_hour || 17);
  if (now.getHours() < openHour || now.getHours() >= closeHour) {
    return res.status(400).json({ error: `Withdrawals only between ${openHour}:00 and ${closeHour}:00` });
  }
  if (amount < (wSettings.min_amount || 5000)) return res.status(400).json({ error: `Min withdrawal: ₦${wSettings.min_amount}` });
  if (amount > (wSettings.max_amount || 500000)) return res.status(400).json({ error: `Max withdrawal: ₦${wSettings.max_amount}` });

  // Check balance
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (wallet.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  // Idempotency key to prevent duplicate
  const idempotencyKey = req.headers['x-idempotency-key'] || `${user.id}_${Date.now()}`;
  const { data: existing } = await supabaseAdmin.from('withdrawals').select('id').eq('user_id', user.id).eq('status', 'pending').maybeSingle();
  if (existing) return res.status(400).json({ error: 'You already have a pending withdrawal' });

  const { data, error } = await supabaseAdmin.from('withdrawals').insert({
    user_id: user.id, amount,
    bank_details: { bank_name, account_number, account_name },
    status: 'pending'
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  // Pre-debit transaction only when approved, so we don't deduct now
  await supabaseAdmin.from('activity_logs').insert({ user_id: user.id, action: 'withdrawal_request', details: { amount } });
  await sendTelegramMessage(`🏧 New withdrawal request: ₦${amount} from ${user.email}`);
  return res.status(200).json(data);
}

async function listWithdrawals(req, res) {
  const user = await verifyUser(req);
  const { data } = await supabaseAdmin.from('withdrawals').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  return res.status(200).json(data);
}

async function approveWithdrawal(req, res) {
  const admin = await verifyAdmin(req);
  const { withdrawal_id, admin_notes } = req.body;
  const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawal_id).single();
  if (!wd || wd.status !== 'pending') return res.status(400).json({ error: 'Invalid withdrawal' });

  // Check balance again
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', wd.user_id).single();
  if (wallet.balance < wd.amount) return res.status(400).json({ error: 'Insufficient balance' });

  // Create transaction (will deduct wallet)
  const { error: txnErr } = await supabaseAdmin.from('transactions').insert({
    user_id: wd.user_id,
    type: 'withdrawal',
    amount: wd.amount,
    status: 'approved',
    reference: `wd_${wd.id}`
  });
  if (txnErr) return res.status(400).json({ error: txnErr.message });

  await supabaseAdmin.from('withdrawals').update({ status: 'approved', admin_notes, updated_at: new Date() }).eq('id', withdrawal_id);
  await sendTelegramMessage(`✅ Withdrawal approved: ₦${wd.amount} to ${wd.bank_details?.account_name}`);
  return res.status(200).json({ message: 'Withdrawal approved' });
}

async function rejectWithdrawal(req, res) {
  const admin = await verifyAdmin(req);
  const { withdrawal_id, admin_notes } = req.body;
  await supabaseAdmin.from('withdrawals').update({ status: 'rejected', admin_notes, updated_at: new Date() }).eq('id', withdrawal_id);
  await sendTelegramMessage(`❌ Withdrawal rejected: ${withdrawal_id}`);
  return res.status(200).json({ message: 'Withdrawal rejected' });
    }
