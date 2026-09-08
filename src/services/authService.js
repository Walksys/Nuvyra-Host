const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { collections, getNextId, settings } = require('../lib/db');
const logger = require('../lib/logger');
const { logActivity, logLogin } = require('./activityService');

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    name: u.name,
    role: u.role,
    root_admin: !!u.root_admin,
    language: u.language,
    avatar: u.avatar,
    verified: !!u.verified,
    suspended: !!u.suspended,
    tfa_enabled: !!u.tfa_enabled,
    last_login_at: u.last_login_at,
    last_login_ip: u.last_login_ip,
    created_at: u.created_at,
  };
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpires }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (_) {
    return null;
  }
}

async function findByUsername(username) {
  return collections.users.findOne({
    $or: [
      { username: String(username).trim() },
      { email: String(username).trim().toLowerCase() },
    ],
  });
}

async function findById(id) {
  return collections.users.findOne({ id: Number(id) });
}

async function createUser({ username, email, password, name, role = 'user', verified = true }) {
  const usernameOk = /^[a-zA-Z0-9_]{3,32}$/.test(username);
  if (!usernameOk) throw new Error('Username must be 3-32 chars (letters, numbers, underscore)');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Invalid email address');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');

  const existing = await collections.users.findOne({
    $or: [{ username }, { email: email.toLowerCase() }],
  });
  if (existing) throw new Error('Username or email already exists');

  const hash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  const id = await getNextId('users');
  const doc = {
    id,
    username,
    email: email.toLowerCase(),
    password: hash,
    name: name || username,
    role,
    root_admin: role === 'admin' ? 1 : 0,
    language: 'en',
    avatar: null,
    verified: verified ? 1 : 0,
    verify_token: null,
    suspended: 0,
    tfa_enabled: 0,
    tfa_secret: null,
    last_login_at: null,
    last_login_ip: null,
    created_at: now,
    updated_at: now,
  };
  await collections.users.insertOne(doc);
  return findById(id);
}

async function updateUser(id, data) {
  const user = await findById(id);
  if (!user) throw new Error('User not found');
  const allowed = ['name', 'email', 'username', 'language', 'avatar', 'role'];
  const $set = {};
  for (const f of allowed) {
    if (data[f] !== undefined) $set[f] = data[f];
  }
  if (data.password) {
    if (data.password.length < 6) throw new Error('Password too short');
    $set.password = bcrypt.hashSync(data.password, 10);
  }
  if (data.suspended !== undefined) $set.suspended = data.suspended ? 1 : 0;
  if (data.verified !== undefined) $set.verified = data.verified ? 1 : 0;
  if (data.root_admin !== undefined) $set.root_admin = data.root_admin ? 1 : 0;
  if (data.tfa_disabled) {
    $set.tfa_enabled = 0;
    $set.tfa_secret = null;
  }
  if (Object.keys($set).length) {
    $set.updated_at = new Date().toISOString();
    if ($set.username || $set.email) {
      const conflict = await collections.users.findOne({
        id: { $ne: Number(id) },
        $or: [
          $set.username ? { username: $set.username } : null,
          $set.email ? { email: $set.email.toLowerCase() } : null,
        ].filter(Boolean),
      });
      if (conflict) throw new Error('Username or email already in use');
    }
    await collections.users.updateOne({ id: Number(id) }, { $set });
  }
  return findById(id);
}

async function deleteUser(id) {
  await collections.users.deleteOne({ id: Number(id) });
  return true;
}

async function countAdmins() {
  return collections.users.countDocuments({
    $or: [{ role: 'admin' }, { root_admin: 1 }],
  });
}

async function attemptLogin(username, password, ip) {
  const user = await findByUsername(username);
  if (!user) {
    await logLogin({ ip, username, status: 'failed_user' });
    return { ok: false, error: 'Invalid username or password' };
  }
  if (!bcrypt.compareSync(password, user.password)) {
    await logLogin({ user_id: user.id, ip, username, status: 'failed_password' });
    await logActivity({ user_id: user.id, event: 'auth:login_failed', ip });
    return { ok: false, error: 'Invalid username or password' };
  }
  if (user.suspended) {
    await logLogin({ user_id: user.id, ip, username, status: 'suspended' });
    return { ok: false, error: 'This account is suspended' };
  }
  return { ok: true, user, tfaRequired: !!user.tfa_enabled };
}

async function finishLogin(user, ip) {
  const now = new Date().toISOString();
  await collections.users.updateOne({ id: user.id }, { $set: { last_login_at: now, last_login_ip: ip } });
  await logLogin({ user_id: user.id, ip, username: user.username, status: 'success' });
  await logActivity({ user_id: user.id, event: 'auth:login', ip });
  const token = signToken(user);
  return { token, user: publicUser({ ...user, last_login_at: now, last_login_ip: ip }) };
}

function genVerifyToken() {
  return uuidv4().replace(/-/g, '');
}

async function createVerifyToken(user) {
  const token = genVerifyToken();
  await collections.users.updateOne({ id: user.id }, { $set: { verify_token: token } });
  return token;
}

async function verifyEmail(token) {
  const user = await collections.users.findOne({ verify_token: token });
  if (!user) return { ok: false, error: 'Invalid or expired verification token' };
  await collections.users.updateOne({ id: user.id }, { $set: { verified: 1, verify_token: null } });
  await logActivity({ user_id: user.id, event: 'auth:email_verified' });
  return { ok: true };
}

async function createResetToken(user) {
  const token = genVerifyToken();
  const id = await getNextId('reset_tokens');
  await collections.reset_tokens.insertOne({
    id,
    user_id: user.id,
    token,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    used: 0,
    created_at: new Date().toISOString(),
  });
  return token;
}

async function resetPassword(token, newPassword) {
  if (!newPassword || newPassword.length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  const row = await collections.reset_tokens.findOne({ token, used: 0 });
  if (!row) return { ok: false, error: 'Invalid or expired token' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'Token expired' };
  const hash = bcrypt.hashSync(newPassword, 10);
  await collections.users.updateOne({ id: row.user_id }, { $set: { password: hash } });
  await collections.reset_tokens.updateOne({ id: row.id }, { $set: { used: 1 } });
  await logActivity({ user_id: row.user_id, event: 'auth:password_reset' });
  return { ok: true };
}

async function setupTfa(user) {
  const secret = speakeasy.generateSecret({ length: 20, name: `${settings.get('panel.name') || 'vpanel'} (${user.username})` });
  await collections.users.updateOne({ id: user.id }, { $set: { tfa_secret: secret.base32 } });
  return { secret: secret.base32, otpauth_url: secret.otpauth_url };
}

function confirmTfa(user, code) {
  if (!user.tfa_secret) return { ok: false, error: '2FA is not configured' };
  const valid = speakeasy.totp.verify({
    secret: user.tfa_secret,
    encoding: 'base32',
    token: String(code).replace(/\s/g, ''),
    window: 1,
  });
  if (!valid) return { ok: false, error: 'Invalid 2FA code' };
  return { ok: true };
}

async function enableTfa(user, code) {
  const check = confirmTfa(user, code);
  if (!check.ok) return check;
  await collections.users.updateOne({ id: user.id }, { $set: { tfa_enabled: 1 } });
  await logActivity({ user_id: user.id, event: 'auth:tfa_enabled' });
  return { ok: true };
}

async function disableTfa(user, code) {
  const check = confirmTfa(user, code);
  if (!check.ok) return check;
  await collections.users.updateOne({ id: user.id }, { $set: { tfa_enabled: 0, tfa_secret: null } });
  await logActivity({ user_id: user.id, event: 'auth:tfa_disabled' });
  return { ok: true };
}

module.exports = {
  publicUser, signToken, generateToken: signToken, verifyToken, findByUsername, findById, createUser, updateUser, deleteUser,
  countAdmins, attemptLogin, finishLogin, createVerifyToken, verifyEmail, createResetToken,
  resetPassword, setupTfa, confirmTfa, enableTfa, disableTfa,
};
