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
      case 'kycList':
        return await kycList(req, res);
      case 'approveKYC':
        return await approveKYC(req, res);
      case 'rejectKYC':
        return await rejectKYC(req, res);
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

  // 2. Debit the wallet. Same defensive pattern as approveDeposit: if
  // no matching transaction exists for some reason, insert one directly
  // instead of silently updating zero rows.
  const { data: existingTxn } = await supabaseAdmin
    .from('transactions')
    .select('id')
    .eq('reference', `wd_${wd.id}`)
    .maybeSingle();

  if (existingTxn) {
    await supabaseAdmin
      .from('transactions')
      .update({ status: 'approved' })
      .eq('reference', `wd_${wd.id}`);
  } else {
    console.warn(`No transaction found for withdrawal ${wd.id} — creating one directly.`);
    const { error: txnInsertErr } = await supabaseAdmin.from('transactions').insert({
      user_id: wd.user_id,
      type: 'withdrawal',
      amount: wd.amount,
      status: 'approved',
      reference: `wd_${wd.id}`
    });
    if (txnInsertErr) {
      return res.status(500).json({ error: `Withdrawal marked approved but wallet debit failed: ${txnInsertErr.message}` });
    }
  }

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

  // 3. No refund needed — the wallet was never debited at request time.
  // The trg_process_transaction trigger only debits balance once the
  // linked transaction is marked 'approved', which never happens for a
  // rejected request (its transaction is marked 'rejected' below), so
  // the funds were never actually removed from the wallet.

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

  // 2. Credit the wallet. If a matching pending transaction already
  // exists (the normal case), updating it to 'approved' is what fires
  // trg_process_transaction. If none exists — e.g. this deposit was
  // created by an older code path that never logged one — the UPDATE
  // below would silently affect zero rows and nothing would be
  // credited, with no error anywhere. Insert one directly in that case
  // instead, which fires the trigger via INSERT.
  const { data: existingTxn } = await supabaseAdmin
    .from('transactions')
    .select('id')
    .eq('reference', `dp_${deposit.id}`)
    .maybeSingle();

  if (existingTxn) {
    await supabaseAdmin
      .from('transactions')
      .update({ status: 'approved' })
      .eq('reference', `dp_${deposit.id}`);
  } else {
    console.warn(`No transaction found for deposit ${deposit.id} — creating one directly.`);
    const { error: txnInsertErr } = await supabaseAdmin.from('transactions').insert({
      user_id: deposit.user_id,
      type: 'deposit',
      amount: deposit.amount,
      status: 'approved',
      reference: `dp_${deposit.id}`
    });
    if (txnInsertErr) {
      return res.status(500).json({ error: `Deposit marked approved but wallet credit failed: ${txnInsertErr.message}` });
    }
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

/**
 * List all KYC documents for admin review, with each private storage
 * path resolved to a short-lived signed URL (service_role — the bucket
 * itself has no public access).
 */
async function kycList(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { data: docs, error } = await supabaseAdmin
    .from('kyc_documents')
    .select('*, profiles(email)')
    .order('submitted_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const withSignedUrls = await Promise.all(
    (docs || []).map(async (doc) => {
      const { data: signed } = await supabaseAdmin.storage
        .from('kyc')
        .createSignedUrl(doc.image_url, 300); // 5 minutes
      return { ...doc, signedUrl: signed?.signedUrl || null };
    })
  );

  return res.status(200).json(withSignedUrls);
}

/**
 * Approve a KYC document and mark the user's profile verified.
 */
async function approveKYC(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  const { data: doc, error: fetchErr } = await supabaseAdmin
    .from('kyc_documents')
    .select('user_id')
    .eq('id', id)
    .single();
  if (fetchErr || !doc) return res.status(404).json({ error: 'Document not found' });

  const { error: docErr } = await supabaseAdmin
    .from('kyc_documents')
    .update({ status: 'approved', reviewed_at: new Date().toISOString() })
    .eq('id', id);
  if (docErr) return res.status(500).json({ error: docErr.message });

  const { error: profileErr } = await supabaseAdmin
    .from('profiles')
    .update({ kyc_status: 'approved', updated_at: new Date().toISOString() })
    .eq('id', doc.user_id);
  if (profileErr) return res.status(500).json({ error: profileErr.message });

  await sendTelegramMessage(
    `✅ *KYC Approved*\n` +
    `Document: \`${id}\`\n` +
    `User ID: \`${doc.user_id}\``
  );

  return res.status(200).json({ message: 'KYC approved' });
}

/**
 * Reject a KYC document with a reason shown to the user.
 */
async function rejectKYC(req, res) {
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Forbidden: Admin access required' });

  const { id, reason } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  const { data: doc, error: fetchErr } = await supabaseAdmin
    .from('kyc_documents')
    .select('user_id')
    .eq('id', id)
    .single();
  if (fetchErr || !doc) return res.status(404).json({ error: 'Document not found' });

  const { error: docErr } = await supabaseAdmin
    .from('kyc_documents')
    .update({
      status: 'rejected',
      admin_notes: reason || null,
      reviewed_at: new Date().toISOString()
    })
    .eq('id', id);
  if (docErr) return res.status(500).json({ error: docErr.message });

  const { error: profileErr } = await supabaseAdmin
    .from('profiles')
    .update({ kyc_status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', doc.user_id);
  if (profileErr) return res.status(500).json({ error: profileErr.message });

  await sendTelegramMessage(
    `❌ *KYC Rejected*\n` +
    `Document: \`${id}\`\n` +
    `User ID: \`${doc.user_id}\`\n` +
    `Reason: ${reason || 'N/A'}`
  );

  return res.status(200).json({ message: 'KYC rejected' });
}
  
