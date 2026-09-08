const { collections, getNextId } = require('../lib/db');
const pluginManager = require('../lib/pluginManager');

async function logActivity({ user_id = null, vm_id = null, event, details = null, ip = null, user_agent = null }) {
  try {
    const id = await getNextId('activity_logs');
    await collections.activity_logs.insertOne({
      id,
      user_id: user_id !== null ? Number(user_id) : null,
      vm_id: vm_id !== null ? Number(vm_id) : null,
      event,
      details,
      ip,
      user_agent,
      created_at: new Date().toISOString(),
    });

    // Dispatch to pluginManager event bus
    pluginManager.emitPlatformEvent(
      event,
      {
        ...(typeof details === 'object' && details !== null ? details : { info: details }),
        user_id,
        vm_id,
      },
      { user_id, vm_id, ip }
    ).catch(() => {});
  } catch (e) { /* noop */ }
}

async function logLogin({ user_id = null, ip, username, status }) {
  try {
    const id = await getNextId('login_attempts');
    await collections.login_attempts.insertOne({
      id,
      user_id: user_id !== null ? Number(user_id) : null,
      ip,
      username,
      status,
      success: status === 'success',
      timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    // Dispatch to pluginManager event bus
    const eventName = status === 'success' ? 'auth:login_success' : 'auth:failed_login';
    pluginManager.emitPlatformEvent(
      eventName,
      { username, ip, status },
      { user_id, ip }
    ).catch(() => {});
  } catch (e) { /* noop */ }
}

async function listActivity({ user_id = null, vm_id = null, limit = 100, offset = 0 }) {
  const query = {};
  if (user_id !== null) query.user_id = Number(user_id);
  if (vm_id !== null) query.vm_id = Number(vm_id);

  const logs = await collections.activity_logs
    .find(query)
    .sort({ id: -1 })
    .skip(Number(offset) || 0)
    .limit(Number(limit) || 100)
    .toArray();

  if (!logs.length) return [];

  const userIds = [...new Set(logs.map((l) => l.user_id).filter((id) => id !== null))];
  const vmIds = [...new Set(logs.map((l) => l.vm_id).filter((id) => id !== null))];

  const [users, vms] = await Promise.all([
    userIds.length ? collections.users.find({ id: { $in: userIds } }).toArray() : [],
    vmIds.length ? collections.vms.find({ id: { $in: vmIds } }).toArray() : [],
  ]);

  const userMap = new Map(users.map((u) => [u.id, u.username]));
  const vmMap = new Map(vms.map((v) => [v.id, v.name]));

  return logs.map((l) => ({
    ...l,
    username: userMap.get(l.user_id) || null,
    vm_name: vmMap.get(l.vm_id) || null,
  }));
}

async function listLoginHistory({ user_id = null, limit = 100, offset = 0 }) {
  const query = {};
  if (user_id !== null) query.user_id = Number(user_id);

  return collections.login_attempts
    .find(query)
    .sort({ id: -1 })
    .skip(Number(offset) || 0)
    .limit(Number(limit) || 100)
    .toArray();
}

async function recentLogin(userId) {
  return collections.login_attempts
    .findOne({ user_id: Number(userId) }, { sort: { id: -1 } });
}

module.exports = { logActivity, logLogin, listActivity, listLoginHistory, recentLogin };
