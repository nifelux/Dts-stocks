import supabaseAdmin from '../lib/supabase.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  // Support actions sent via URL query (?action=...) or request body ({ action: '...' })
  const action = req.query.action || req.body?.action;

  try {
    switch (action) {
      case 'getWallet':
        return await getWallet(req, res);
      case 'getTransactions':
        return await getTransactions(req, res);
      case 'getWithdrawals':
        return await getWithdrawals(req, res);
      case 'getDeposits':
        return await getDeposits(req, res);
      case 'createDeposit':
        return await createDeposit(req, res);
      case 'createWithdrawal':
      case 'withdraw':
        return await createWithdrawal(req, res);
      default:
        return res.status(400).json({ error: `Invalid or missing action parameter: '${action}'` });
    }
  } catch (err) {
    console.error('Finance API Handler Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

/**
 * Fetch Current User Wallet
 */
async function getWallet(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized: Please log in' });

  const { data: wallet, error } = await supabaseAdmin
    .from('wallets')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    return res.status(500).json({ error: 'Failed to fetch wallet information' });
  }

  if (!wallet) {
    return res.status(200).json({ balance: 0, currency: 'NGN' });
  }

  return res.status(200).json(wallet);
}

/**
 * Fetch User Transaction Log
 */
async function getTransactions(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized: Please log in' });

  const { data: transactions, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Failed to fetch transaction history' });
  }

  return res.status(200).json({ transactions });
}

/**
 * Fetch User Withdrawals
 */
async function getWithdrawals(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized: Please log in' });

  const { data: withdrawals, error } = await supabaseAdmin
    .from('withdrawals')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }

  return res.status(200).json({ withdrawals });
}

/**
 * Fetch User Deposits
 */
async function getDeposits(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized: Please log in' });

  const { data: deposits, error } = await supabaseAdmin
    .from('deposits')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Failed to fetch deposits' });
  }

  return res.status(200).json({ deposits });
}

/**
 * Submit Manual Deposit Request
 */
async function createDeposit(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized: Please log in' });

  const { amount, payment_method, payment_details, proof_url, reference } = req.body;

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Please enter a valid deposit amount' });
  }

  // 1. Create Deposit Record
  const { data: deposit, error: depErr } = await supabaseAdmin
    .from('deposits')
    .insert({
      user_id: user.id,
      amount: Number(amount),
      payment_method: payment_method || 'bank_transfer',
      payment_details: payment_details || null,
      proof_url: proof_url || null,
      reference: reference || `dp_ref_${Date.now()}`,
      status: 'pending',
      created_at: new Date()
    })
    .select()
    .single();

  if (depErr) {
    return res.status(500).json({ error: depErr.message });
  }

  // 2. Log Pending Transaction
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'deposit',
    amount: Number(amount),
    status: 'pending',
    reference: `dp_${deposit.id}`,
    description: `Deposit request via ${payment_method || 'bank_transfer'}`,
    created_at: new Date()
  });

  // 3. Telegram Notification
  await sendTelegramMessage(
    `📥 *New Deposit Request*\n` +
    `User ID: \`${user.id}\`\n` +
    `Amount: ₦${amount}\n` +
    `Deposit ID: \`${deposit.id}\``
  );

  return res.status(201).json({
    message: 'Deposit request submitted successfully and awaiting approval',
    deposit
  });
}

/**
 * Submit Withdrawal Request
 */
async function createWithdrawal(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized: Please log in' });

  const { amount, bank_code, bank_name, account_number, account_name } = req.body;

  // 1. Input Validations
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Please enter a valid withdrawal amount' });
  }
  if (!account_number || !account_name) {
    return res.status(400).json({ error: 'Account number and account name are required' });
  }

  // 2. KYC Status Verification
  const { data: kycProfile } = await supabaseAdmin
    .from('profiles')
    .select('kyc_status')
    .eq('id', user.id)
    .single();

  if (!kycProfile || kycProfile.kyc_status !== 'approved') {
    return res.status(403).json({ error: 'KYC verification is required before making withdrawals' });
  }

  // 3. Wallet Balance Check — account for amounts already tied up in
  // other pending withdrawal requests, since the balance itself is no
  // longer debited until an admin approves (see below).
  const { data: wallet, error: walletErr } = await supabaseAdmin
    .from('wallets')
    .select('balance')
    .eq('user_id', user.id)
    .single();

  if (walletErr || !wallet) {
    return res.status(400).json({ error: 'Wallet record not found' });
  }

  const { data: pendingRows } = await supabaseAdmin
    .from('withdrawals')
    .select('amount')
    .eq('user_id', user.id)
    .eq('status', 'pending');

  const pendingTotal = (pendingRows || []).reduce((sum, r) => sum + Number(r.amount), 0);
  const availableBalance = Number(wallet.balance) - pendingTotal;

  if (Number(amount) > availableBalance) {
    return res.status(400).json({ error: 'Insufficient available balance (some funds may be tied up in pending withdrawal requests)' });
  }

  // 4. Create Withdrawal Record (Status: pending). The wallet is NOT
  // debited here — trg_process_transaction debits it automatically
  // once the linked transaction below is marked 'approved' by an admin.
  // Debiting it here too was the cause of the double-debit bug.
  const { data: wd, error: wdErr } = await supabaseAdmin
    .from('withdrawals')
    .insert({
      user_id: user.id,
      amount: Number(amount),
      bank_details: { bank_code, bank_name, account_number, account_name },
      status: 'pending',
      created_at: new Date()
    })
    .select()
    .single();

  if (wdErr) {
    return res.status(500).json({ error: wdErr.message });
  }

  // 5. Log Transaction Record Immediately as Pending
  await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'withdrawal',
    amount: Number(amount),
    status: 'pending',
    reference: `wd_${wd.id}`,
    description: `Withdrawal request to ${account_name} (${bank_name || bank_code || 'Bank'})`,
    created_at: new Date()
  });

  // 6. Telegram Notification
  await sendTelegramMessage(
    `💸 *New Withdrawal Request*\n` +
    `User ID: \`${user.id}\`\n` +
    `Amount: ₦${amount}\n` +
    `Bank: ${bank_name || bank_code || 'N/A'}\n` +
    `Account: ${account_number} (${account_name})\n` +
    `Withdrawal ID: \`${wd.id}\``
  );

  return res.status(201).json({
    message: 'Withdrawal request submitted successfully',
    withdrawal: wd
  });
}
