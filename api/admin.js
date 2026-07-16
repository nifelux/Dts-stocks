/**
 * Admin API – Comprehensive management actions
 * Actions: stats, users, freezeUser, banUser, unbanUser, creditWallet, debitWallet,
 *          lockWithdrawals, openWithdrawals, maintenanceMode, settingsGet, settingsUpdate,
 *          broadcast, getAuditLogs, getActivityLogs, exportCSV, etc.
 */
import supabaseAdmin from '../lib/supabase.js';
import { verifyAdmin } from '../lib/auth.js';
import { sendTelegramMessage } from '../lib/telegram.js';

export default async function handler(req, res) {
  const { action } = req.query;
  try {
    switch (action) {
      case 'stats': return getStats(req, res);
      case 'users': return getUsers(req, res);
      case 'userDetail': return getUserDetail(req, res);
      case 'freezeUser': return freezeUser(req, res);
      case 'unfreezeUser': return unfreezeUser(req, res);
      case 'banUser': return banUser(req, res);
      case 'unbanUser': return unbanUser(req, res);
      case 'creditWallet': return creditWallet(req, res);
      case 'debitWallet': return debitWallet(req, res);
      case 'lockWithdrawals': return lockWithdrawals(req, res);
      case 'openWithdrawals': return openWithdrawals(req, res);
      case 'maintenanceMode': return maintenanceMode(req, res);
      case 'settingsGet': return settingsGet(req, res);
      case 'settingsUpdate': return settingsUpdate(req, res);
      case 'broadcast': return broadcast(req, res);
      case 'auditLogs': return getAuditLogs(req, res);
      case 'activityLogs': return getActivityLogs(req, res);
      case 'exportCSV': return exportCSV(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function getStats(req, res) {
  await verifyAdmin(req);
  const [users, deposits, withdrawals, investments, transactions] = await Promise.all([
    supabaseAdmin.from('profiles').select('id', { count: 'exact' }),
    supabaseAdmin.from('deposits').select('amount', { count: 'exact' }).eq('status', 'approved'),
    supabaseAdmin.from('withdrawals').select('amount', { count: 'exact' }).eq('status', 'approved'),
    supabaseAdmin.from('investments').select('amount', { count: 'exact' }),
    supabaseAdmin.from('transactions').select('amount, type').eq('status', 'approved')
  ]);
  const totalDeposits = deposits.data.reduce((sum, d) => sum + d.amount, 0);
  const totalWithdrawals = withdrawals.data.reduce((sum, w) => sum + w.amount, 0);
  return res.status(200).json({
    totalUsers: users.count,
    totalDeposits,
    totalWithdrawals,
    totalInvestments: investments.data.reduce((s, i) => s + i.amount, 0),
    activeInvestments: investments.data.filter(i => i.status === 'active').length
  });
}

async function getUsers(req, res) {
  await verifyAdmin(req);
  const { page = 0, limit = 20, search } = req.query;
  let query = supabaseAdmin.from('profiles').select('*, wallets(balance)');
  if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
  const { data, error, count } = await query.range(page * limit, (page * limit) + limit - 1).order('created_at', { ascending: false });
  return res.status(200).json({ data, count });
}

async function getUserDetail(req, res) {
  await verifyAdmin(req);
  const { id } = req.query;
  const { data } = await supabaseAdmin.from('profiles').select('*, wallets(*)').eq('id', id).single();
  return res.status(200).json(data);
}

async function freezeUser(req, res) {
  await verifyAdmin(req);
  const { user_id } = req.body;
  await supabaseAdmin.from('profiles').update({ is_frozen: true }).eq('id', user_id);
  return res.status(200).json({ message: 'User frozen' });
}

async function unfreezeUser(req, res) {
  await verifyAdmin(req);
  const { user_id } = req.body;
  await supabaseAdmin.from('profiles').update({ is_frozen: false }).eq('id', user_id);
  return res.status(200).json({ message: 'User unfrozen' });
}

async function banUser(req, res) {
  await verifyAdmin(req);
  const { user_id, reason } = req.body;
  await supabaseAdmin.from('profiles').update({ is_banned: true, ban_reason: reason }).eq('id', user_id);
  return res.status(200).json({ message: 'User banned' });
}

async function unbanUser(req, res) {
  await verifyAdmin(req);
  const { user_id } = req.body;
  await supabaseAdmin.from('profiles').update({ is_banned: false, ban_reason: null }).eq('id', user_id);
  return res.status(200).json({ message: 'User unbanned' });
}

async function creditWallet(req, res) {
  await verifyAdmin(req);
  const { user_id, amount, note } = req.body;
  await supabaseAdmin.from('transactions').insert({
    user_id, type: 'admin_credit', amount, status: 'approved', reference: `admin_credit_${Date.now()}`, meta: { note }
  });
  return res.status(200).json({ message: 'Wallet credited' });
}

async function debitWallet(req, res) {
  await verifyAdmin(req);
  const { user_id, amount, note } = req.body;
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user_id).single();
  if (wallet.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
  await supabaseAdmin.from('transactions').insert({
    user_id, type: 'admin_debit', amount, status: 'approved', reference: `admin_debit_${Date.now()}`, meta: { note }
  });
  return res.status(200).json({ message: 'Wallet debited' });
}

async function lockWithdrawals(req, res) {
  await verifyAdmin(req);
  await supabaseAdmin.from('settings').update({ value: { ...(await getSetting('withdrawal')), enabled: false } }).eq('key', 'withdrawal');
  return res.status(200).json({ message: 'Withdrawals locked' });
}

async function openWithdrawals(req, res) {
  await verifyAdmin(req);
  await supabaseAdmin.from('settings').update({ value: { ...(await getSetting('withdrawal')), enabled: true } }).eq('key', 'withdrawal');
  return res.status(200).json({ message: 'Withdrawals opened' });
}

async function maintenanceMode(req, res) {
  await verifyAdmin(req);
  const { enabled } = req.body;
  await supabaseAdmin.from('settings').upsert({ key: 'maintenance_mode', value: enabled ? 'true' : 'false' });
  return res.status(200).json({ message: `Maintenance ${enabled ? 'enabled' : 'disabled'}` });
}

async function settingsGet(req, res) {
  await verifyAdmin(req);
  const { data } = await supabaseAdmin.from('settings').select('*');
  return res.status(200).json(data);
}

async function settingsUpdate(req, res) {
  await verifyAdmin(req);
  const { key, value } = req.body;
  await supabaseAdmin.from('settings').upsert({ key, value });
  return res.status(200).json({ message: 'Setting updated' });
}

async function broadcast(req, res) {
  await verifyAdmin(req);
  const { title, body } = req.body;
  // Notify all users (insert notification for each)
  const { data: users } = await supabaseAdmin.from('profiles').select('id');
  const notifications = users.map(u => ({ user_id: u.id, title, body }));
  await supabaseAdmin.from('notifications').insert(notifications);
  return res.status(200).json({ message: 'Broadcast sent' });
}

async function getAuditLogs(req, res) {
  await verifyAdmin(req);
  const { page = 0, limit = 50 } = req.query;
  const { data } = await supabaseAdmin.from('audit_logs').select('*').range(page * limit, (page * limit) + limit - 1).order('created_at', { ascending: false });
  return res.status(200).json(data);
}

async function getActivityLogs(req, res) {
  await verifyAdmin(req);
  const { page = 0, limit = 50, userId } = req.query;
  let query = supabaseAdmin.from('activity_logs').select('*');
  if (userId) query = query.eq('user_id', userId);
  const { data } = await query.range(page * limit, (page * limit) + limit - 1).order('created_at', { ascending: false });
  return res.status(200).json(data);
}

async function exportCSV(req, res) {
  await verifyAdmin(req);
  const { table } = req.query;
  if (!['transactions','deposits','withdrawals','investments','users'].includes(table)) return res.status(400).json({ error: 'Invalid table' });
  const { data } = await supabaseAdmin.from(table).select('*').limit(1000);
  // Convert to CSV
  const csv = data.length ? [Object.keys(data[0]).join(','), ...data.map(row => Object.values(row).map(v => `"${v}"`).join(','))].join('\n') : '';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${table}.csv`);
  return res.status(200).send(csv);
}

async function getSetting(key) {
  const { data } = await supabaseAdmin.from('settings').select('value').eq('key', key).single();
  return data?.value || {};
    }
