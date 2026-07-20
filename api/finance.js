/**
 * Finance API – Deposits, Withdrawals & Community Proofs
 * Actions: createDeposit, listDeposits, approveDeposit, rejectDeposit,
 *          createWithdrawal, listWithdrawals, approveWithdrawal, rejectWithdrawal,
 *          createWithdrawalProof, listWithdrawalProofs, addProofComment
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyUser, verifyAdmin } from '../lib/auth.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { withdrawSchema } from '../lib/validation.js';

export default async function handler(req, res) {
  const { action } = req.query;
  try {
    switch (action) {
      case 'createDeposit': return await createDeposit(req, res);
      case 'listDeposits': return await listDeposits(req, res);
      case 'approveDeposit': return await approveDeposit(req, res);
      case 'rejectDeposit': return await rejectDeposit(req, res);
      case 'createWithdrawal': return await createWithdrawal(req, res);
      case 'listWithdrawals': return await listWithdrawals(req, res);
      case 'approveWithdrawal': return await approveWithdrawal(req, res);
      case 'rejectWithdrawal': return await rejectWithdrawal(req, res);
      case 'createWithdrawalProof': return await createWithdrawalProof(req, res);
      case 'listWithdrawalProofs': return await listWithdrawalProofs(req, res);
      case 'addProofComment': return await addProofComment(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================
// DEPOSITS (Unchanged from original)
// ============================================================

async function createDeposit(req, res) {
  const user = await verifyUser(req);
  const { amount, payment_method, payment_details } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid deposit amount' });
  if (!payment_details || !payment_details.trim()) return res.status(400).json({ error: 'Sender name and bank name are required' });

  const { data, error } = await supabaseAdmin.from('deposits').insert({
    user_id: user.id,
    amount,
    payment_method: payment_method || 'bank_transfer',
    proof_image_url: payment_details, // stored as text details
    payment_details: payment_details
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });

  await supabaseAdmin.from('activity_logs').insert({ user_id: user.id, action: 'deposit_request', details: { amount, details: payment_details } });
  await sendTelegramMessage(`💰 New deposit request: ₦${amount} from ${user.email}\nSender Details: ${payment_details}`);
  return res.status(200).json(data);
}

async function listDeposits(req, res) {
  const user = await verifyUser(req);
  const { data } = await supabaseAdmin.from('deposits').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  return res.status(200).json(data);
}

async function approveDeposit(req, res) {
  const admin = await verifyAdmin(req);
  const { deposit_id, admin_notes } = req.body;

  const { data: deposit } = await supabaseAdmin.from('deposits').select('*').eq('id', deposit_id).single();
  if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
  if (deposit.status !== 'pending') return res.status(400).json({ error: 'Deposit already processed' });

  await supabaseAdmin.from('deposits').update({ status: 'approved', admin_notes, updated_at: new Date() }).eq('id', deposit_id);

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

// ============================================================
// WITHDRAWALS
// ============================================================

async function createWithdrawal(req, res) {
  const user = await verifyUser(req);

  // 1. KYC Enforcement Check
  const { data: kycCheck } = await supabaseAdmin.from('profiles').select('kyc_status').eq('id', user.id).single();
  if (!kycCheck || kycCheck.kyc_status !== 'approved') {
    return res.status(400).json({ error: 'KYC verification required to withdraw. Please upload your face and full name on the KYC page.' });
  }

  const { amount, bank_code, bank_name, account_number, account_name } = req.body;
  try { withdrawSchema.parse(req.body); } catch (e) { return res.status(400).json({ error: e.errors[0].message }); }

  // 2. Settings validation
  const { data: settings } = await supabaseAdmin.from('settings').select('*').eq('key', 'withdrawal').single();
  const wSettings = settings?.value || {};
  if (wSettings.enabled === false) return res.status(400).json({ error: 'Withdrawals disabled' });

  const now = new Date();
  const openHour = parseInt(wSettings.open_hour || 10);
  const closeHour = parseInt(wSettings.close_hour || 17);
  if (now.getHours() < openHour || now.getHours() >= closeHour) {
    return res.status(400).json({ error: `Withdrawals only between ${openHour}:00 and ${closeHour}:00` });
  }

  if (amount < (wSettings.min_amount || 5000)) return res.status(400).json({ error: `Min withdrawal: ₦${wSettings.min_amount}` });
  if (amount > (wSettings.max_amount || 500000)) return res.status(400).json({ error: `Max withdrawal: ₦${wSettings.max_amount}` });

  // 3. Balance Check & Deduct Immediately for Manual Processing
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (!wallet || wallet.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  const { data: existing } = await supabaseAdmin.from('withdrawals').select('id').eq('user_id', user.id).eq('status', 'pending').maybeSingle();
  if (existing) return res.status(400).json({ error: 'You already have a pending withdrawal' });

  // Lock user's requested amount
  const newBalance = Number(wallet.balance) - Number(amount);
  const { error: deductErr } = await supabaseAdmin.from('wallets').update({ balance: newBalance }).eq('user_id', user.id);
  if (deductErr) return res.status(400).json({ error: deductErr.message });

  // 4. Create Withdrawal Record
  const { data, error } = await supabaseAdmin.from('withdrawals').insert({
    user_id: user.id, 
    amount,
    bank_details: { bank_code, bank_name, account_number, account_name },
    status: 'pending'
  }).select().single();

  if (error) {
    // Refund if database insert fails
    await supabaseAdmin.from('wallets').update({ balance: wallet.balance }).eq('user_id', user.id);
    return res.status(400).json({ error: error.message });
  }

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
  if (!wd || wd.status !== 'pending') return res.status(400).json({ error: 'Invalid or already processed withdrawal' });

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
  const { data: wd } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawal_id).single();
  if (!wd || wd.status !== 'pending') return res.status(400).json({ error: 'Invalid or already processed withdrawal' });

  // Mark as rejected
  await supabaseAdmin.from('withdrawals').update({ status: 'rejected', admin_notes, updated_at: new Date() }).eq('id', withdrawal_id);

  // Refund funds back to user's wallet
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', wd.user_id).single();
  if (wallet) {
    const refundedBalance = Number(wallet.balance) + Number(wd.amount);
    await supabaseAdmin.from('wallets').update({ balance: refundedBalance }).eq('user_id', wd.user_id);
  }

  await sendTelegramMessage(`❌ Withdrawal rejected and refunded: ${withdrawal_id}`);
  return res.status(200).json({ message: 'Withdrawal rejected and refunded' });
}

// ============================================================
// COMMUNITY PROOFS & COMMENTS
// ============================================================

async function createWithdrawalProof(req, res) {
  const user = await verifyUser(req);
  const { amount, image_url, caption } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Please enter a valid amount' });
  if (!image_url) return res.status(400).json({ error: 'Screenshot image is required' });

  const { data, error } = await supabaseAdmin.from('withdrawal_proofs').insert({
    user_id: user.id,
    amount: Number(amount),
    image_url,
    caption: caption || ''
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json(data);
}

async function listWithdrawalProofs(req, res) {
  const { data: proofs, error } = await supabaseAdmin
    .from('withdrawal_proofs')
    .select('*, profiles(full_name, email), proof_comments(*, profiles(full_name, email))')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const items = await Promise.all(proofs.map(async (p) => {
    let url = p.image_url;
    if (url && !url.startsWith('http')) {
      const { data: signed } = await supabaseAdmin.storage.from('proofs').createSignedUrl(url, 3600);
      url = signed?.signedUrl || url;
    }
    return { ...p, display_url: url };
  }));

  return res.status(200).json(items);
}

async function addProofComment(req, res) {
  const user = await verifyUser(req);
  const { proof_id, comment } = req.body;

  if (!proof_id) return res.status(400).json({ error: 'Missing proof_id' });
  if (!comment || !comment.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });

  const { data, error } = await supabaseAdmin.from('proof_comments').insert({
    proof_id,
    user_id: user.id,
    comment: comment.trim()
  }).select('*, profiles(full_name, email)').single();

  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json(data);
}
