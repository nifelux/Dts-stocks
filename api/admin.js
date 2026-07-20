import supabaseAdmin from '../lib/supabase.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { verifyAdmin } from '../lib/auth.js';

export default async function handler(req, res) {
  // Support actions sent via URL query (?action=...) or request body ({ action: '...' })
  const action = req.query.action || req.body?.action;

  try {
    switch (action) {
      case 'getAdminWithdrawals':
      case 'withdrawalsList':
        return await getAdminWithdrawals(req, res);
      case 'getAdminDeposits':
      case 'depositsList':
        return await getAdminDeposits(req, res);
      case 'approveWithdrawal':
        return await approveWithdrawal(req, res);
      case 'rejectWithdrawal':
        return await rejectWithdrawal(req, res);
      case 'approveDeposit':
        return await approveDeposit(req, res);
      case 'rejectDeposit':
        return await rejectDeposit(req, res);
      default:
        return res.status(400).json({ error: `Invalid or missing admin action: '${action}'` });
    }
  } catch (err) {
    console.error('Admin API Handler Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

/**
 * Get List of Withdrawals for Admin
 */
async function getAdminWithdrawals(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { status } = req.query;
  let query = supabaseAdmin
    .from('withdrawals')
    .select('*, profiles(email, full_name)')
    .order('created_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data: withdrawals, error } = await query;
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ withdrawals });
}

/**
 * Get List of Deposits for Admin
 */
async function getAdminDeposits(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { status } = req.query;
  let query = supabaseAdmin
    .from('deposits')
    .select('*, profiles(email, full_name)')
    .order('created_at', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data: deposits, error } = await query;
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ deposits });
}

/**
 * Approve Pending Withdrawal
 */
async function approveWithdrawal(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { withdrawal_id, admin_notes } = req.body;
  if (!withdrawal_id) return res.status(400).json({ error: 'Withdrawal ID is required' });

  const { data: wd } = await supabaseAdmin
    .from('withdrawals')
    .select('*')
    .eq('id', withdrawal_id)
    .single();

  if (!wd || wd.status !== 'pending') {
    return res.status(400).json({ error: 'Withdrawal record not found or already processed' });
  }

  // 1. Mark Withdrawal Approved
  const { error: wdErr } = await supabaseAdmin
    .from('withdrawals')
    .update({
      status: 'approved',
      admin_notes: admin_notes || null,
      updated_at: new Date()
    })
    .eq('id', withdrawal_id);

  if (wdErr) {
    return res.status(500).json({ error: 'Failed to update withdrawal status' });
  }

  // 2. Mark Transaction Approved
  await supabaseAdmin
    .from('transactions')
    .update({ status: 'approved' })
    .eq('reference', `wd_${wd.id}`);

  // 3. Send Notification
  await sendTelegramMessage(
    `✅ *Withdrawal Approved*\n` +
    `ID: \`${wd.id}\`\n` +
    `Amount: ₦${wd.amount}\n` +
    `User ID: \`${wd.user_id}\``
  );

  return res.status(200).json({ message: 'Withdrawal approved successfully' });
}

/**
 * Reject Withdrawal & Refund User Balance
 */
async function rejectWithdrawal(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { withdrawal_id, admin_notes } = req.body;
  if (!withdrawal_id) return res.status(400).json({ error: 'Withdrawal ID is required' });

  const { data: wd } = await supabaseAdmin
    .from('withdrawals')
    .select('*')
    .eq('id', withdrawal_id)
    .single();

  if (!wd || wd.status !== 'pending') {
    return res.status(400).json({ error: 'Withdrawal record not found or already processed' });
  }

  // 1. Mark Withdrawal Rejected
  const { error: wdErr } = await supabaseAdmin
    .from('withdrawals')
    .update({
      status: 'rejected',
      admin_notes: admin_notes || null,
      updated_at: new Date()
    })
    .eq('id', withdrawal_id);

  if (wdErr) {
    return res.status(500).json({ error: 'Failed to update withdrawal status' });
  }

  // 2. Mark Transaction Rejected
  await supabaseAdmin
    .from('transactions')
    .update({ status: 'rejected' })
    .eq('reference', `wd_${wd.id}`);

  // 3. Refund Wallet Balance
  const { error: rpcErr } = await supabaseAdmin.rpc('credit_wallet_balance', {
    p_user_id: wd.user_id,
    p_amount: Number(wd.amount)
  });

  if (rpcErr) {
    // Fallback: Direct database update if stored procedure fails
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', wd.user_id)
      .single();

    if (wallet) {
      const refundedBalance = Number(wallet.balance) + Number(wd.amount);
      await supabaseAdmin
        .from('wallets')
        .update({ balance: refundedBalance, updated_at: new Date() })
        .eq('user_id', wd.user_id);
    }
  }

  // 4. Send Notification
  await sendTelegramMessage(
    `❌ *Withdrawal Rejected & Refunded*\n` +
    `ID: \`${wd.id}\`\n` +
    `Amount: ₦${wd.amount}\n` +
    `Reason: ${admin_notes || 'N/A'}`
  );

  return res.status(200).json({ message: 'Withdrawal rejected and funds refunded' });
}

/**
 * Approve Pending Deposit and Credit User Balance
 */
async function approveDeposit(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { deposit_id, admin_notes } = req.body;
  if (!deposit_id) return res.status(400).json({ error: 'Deposit ID is required' });

  const { data: deposit } = await supabaseAdmin
    .from('deposits')
    .select('*')
    .eq('id', deposit_id)
    .single();

  if (!deposit || deposit.status !== 'pending') {
    return res.status(400).json({ error: 'Deposit record not found or already processed' });
  }

  // 1. Mark Deposit Approved
  const { error: depErr } = await supabaseAdmin
    .from('deposits')
    .update({
      status: 'approved',
      admin_notes: admin_notes || null,
      updated_at: new Date()
    })
    .eq('id', deposit_id);

  if (depErr) {
    return res.status(500).json({ error: 'Failed to update deposit status' });
  }

  // 2. Mark Transaction Approved
  await supabaseAdmin
    .from('transactions')
    .update({ status: 'approved' })
    .eq('reference', `dp_${deposit.id}`);

  // 3. Credit User Balance
  const { error: rpcErr } = await supabaseAdmin.rpc('credit_wallet_balance', {
    p_user_id: deposit.user_id,
    p_amount: Number(deposit.amount)
  });

  if (rpcErr) {
    // Fallback: Direct database upsert if stored procedure fails
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', deposit.user_id)
      .single();

    const currentBalance = wallet ? Number(wallet.balance) : 0;
    await supabaseAdmin.from('wallets').upsert({
      user_id: deposit.user_id,
      balance: currentBalance + Number(deposit.amount),
      updated_at: new Date()
    });
  }

  // 4. Send Notification
  await sendTelegramMessage(
    `✅ *Deposit Approved & Credited*\n` +
    `ID: \`${deposit.id}\`\n` +
    `Amount: ₦${deposit.amount}\n` +
    `User ID: \`${deposit.user_id}\``
  );

  return res.status(200).json({ message: 'Deposit approved and wallet credited successfully' });
}

/**
 * Reject Deposit Request
 */
async function rejectDeposit(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { deposit_id, admin_notes } = req.body;
  if (!deposit_id) return res.status(400).json({ error: 'Deposit ID is required' });

  const { data: deposit } = await supabaseAdmin
    .from('deposits')
    .select('*')
    .eq('id', deposit_id)
    .single();

  if (!deposit || deposit.status !== 'pending') {
    return res.status(400).json({ error: 'Deposit record not found or already processed' });
  }

  // 1. Mark Deposit Rejected
  const { error: depErr } = await supabaseAdmin
    .from('deposits')
    .update({
      status: 'rejected',
      admin_notes: admin_notes || null,
      updated_at: new Date()
    })
    .eq('id', deposit_id);

  if (depErr) {
    return res.status(500).json({ error: 'Failed to update deposit status' });
  }

  // 2. Mark Transaction Rejected
  await supabaseAdmin
    .from('transactions')
    .update({ status: 'rejected' })
    .eq('reference', `dp_${deposit.id}`);

  // 3. Send Notification
  await sendTelegramMessage(
    `❌ *Deposit Rejected*\n` +
    `ID: \`${deposit.id}\`\n` +
    `Amount: ₦${deposit.amount}\n` +
    `Reason: ${admin_notes || 'N/A'}`
  );

  return res.status(200).json({ message: 'Deposit rejected successfully' });
}
