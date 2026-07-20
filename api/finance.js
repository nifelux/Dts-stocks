import { supabaseAdmin } from '../lib/supabase.js';
import { sendTelegramMessage } from '../lib/telegram.js';
import { verifyUser } from '../lib/auth.js';

/**
 * Get User Wallet Balance
 */
export async function getWallet(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: wallet, error } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: 'Failed to fetch wallet' });
    }

    // If wallet doesn't exist yet, return zero balance
    if (!wallet) {
      return res.status(200).json({ balance: 0, currency: 'NGN' });
    }

    return res.status(200).json(wallet);
  } catch (error) {
    console.error('Get Wallet Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get User Transaction History
 */
export async function getTransactions(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: transactions, error } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch transaction history' });
    }

    return res.status(200).json({ transactions });
  } catch (error) {
    console.error('Get Transactions Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get User Withdrawal History
 */
export async function getWithdrawals(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: withdrawals, error } = await supabaseAdmin
      .from('withdrawals')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch withdrawals' });
    }

    return res.status(200).json({ withdrawals });
  } catch (error) {
    console.error('Get Withdrawals Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get User Deposit History
 */
export async function getDeposits(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: deposits, error } = await supabaseAdmin
      .from('deposits')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch deposits' });
    }

    return res.status(200).json({ deposits });
  } catch (error) {
    console.error('Get Deposits Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Handle User Deposit Request
 */
export async function createDeposit(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { amount, payment_method, proof_url, reference } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Please enter a valid deposit amount' });
    }
    if (!payment_method) {
      return res.status(400).json({ error: 'Payment method is required' });
    }

    // 1. Create Deposit Record (Pending)
    const { data: deposit, error: depErr } = await supabaseAdmin
      .from('deposits')
      .insert({
        user_id: user.id,
        amount: Number(amount),
        payment_method,
        proof_url: proof_url || null,
        reference: reference || `dp_ref_${Date.now()}`,
        status: 'pending',
        created_at: new Date()
      })
      .select()
      .single();

    if (depErr) {
      return res.status(500).json({ error: 'Failed to record deposit request' });
    }

    // 2. Log Pending Transaction Entry
    await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'deposit',
      amount: Number(amount),
      status: 'pending',
      reference: `dp_${deposit.id}`,
      description: `Deposit request via ${payment_method}`,
      created_at: new Date()
    });

    // 3. Admin Notification
    await sendTelegramMessage(
      `📥 *New Deposit Request*\n` +
      `User ID: \`${user.id}\`\n` +
      `Amount: ₦${amount}\n` +
      `Method: ${payment_method}\n` +
      `Deposit ID: \`${deposit.id}\``
    );

    return res.status(201).json({
      message: 'Deposit submitted and awaiting approval',
      deposit
    });
  } catch (error) {
    console.error('Create Deposit Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Handle User Withdrawal Request
 */
export async function createWithdrawal(req, res) {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { amount, bank_code, bank_name, account_number, account_name } = req.body;

    // 1. Basic Validations
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Please enter a valid withdrawal amount' });
    }
    if (!bank_code || !account_number || !account_name) {
      return res.status(400).json({ error: 'Complete bank details are required' });
    }

    // 2. KYC Verification Verification Check
    const { data: kycProfile } = await supabaseAdmin
      .from('profiles')
      .select('kyc_status')
      .eq('id', user.id)
      .single();

    if (!kycProfile || kycProfile.kyc_status !== 'approved') {
      return res.status(403).json({ error: 'You must complete KYC verification before making a withdrawal' });
    }

    // 3. Check Wallet Balance
    const { data: wallet, error: walletErr } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    if (walletErr || !wallet) {
      return res.status(400).json({ error: 'Failed to fetch wallet details' });
    }

    if (Number(wallet.balance) < Number(amount)) {
      return res.status(400).json({ error: 'Insufficient wallet balance' });
    }

    // 4. Deduct Wallet Balance Immediately
    const newBalance = Number(wallet.balance) - Number(amount);
    const { error: deductErr } = await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance, updated_at: new Date() })
      .eq('user_id', user.id);

    if (deductErr) {
      return res.status(500).json({ error: 'Failed to deduct wallet balance' });
    }

    // 5. Create Withdrawal Record (Status: Pending)
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
      // Rollback wallet deduction if withdrawal insert fails
      await supabaseAdmin
        .from('wallets')
        .update({ balance: wallet.balance, updated_at: new Date() })
        .eq('user_id', user.id);

      return res.status(500).json({ error: 'Failed to record withdrawal request' });
    }

    // 6. Log Transaction History Immediately as 'Pending'
    const { error: txErr } = await supabaseAdmin.from('transactions').insert({
      user_id: user.id,
      type: 'withdrawal',
      amount: Number(amount),
      status: 'pending',
      reference: `wd_${wd.id}`,
      description: `Withdrawal request to ${account_name} (${bank_name || bank_code})`,
      created_at: new Date()
    });

    if (txErr) {
      console.error('Transaction logging error:', txErr.message);
    }

    // 7. Notify Admin via Telegram
    await sendTelegramMessage(
      `💸 *New Withdrawal Request*\n` +
      `User ID: \`${user.id}\`\n` +
      `Amount: ₦${amount}\n` +
      `Bank: ${bank_name || bank_code}\n` +
      `Account: ${account_number} (${account_name})\n` +
      `Withdrawal ID: \`${wd.id}\``
    );

    return res.status(201).json({
      message: 'Withdrawal request submitted successfully',
      withdrawal: wd
    });
  } catch (error) {
    console.error('Withdrawal Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
