const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { collections, settings } = require('../lib/db');
const vmService = require('../services/vmService');
const backupService = require('../services/backupService');
const authService = require('../services/authService');
const activity = require('../services/activityService');
const { requireAdmin } = require('../middleware/auth');
const { uploadLogo, uploadFavicon, uploadBackground, uploadMusic } = require('../middleware/upload');
const multer = require('multer');
const fs2 = require('fs');
const createUpload = multer({ dest: config.root + '/data/tmp' });
const router = express.Router();

router.use(requireAdmin);

function render(res, view, vars = {}) {
  res.render(`admin/${view}`, {
    page: 'admin-' + view,
    user: res.req.user,
    settings: settings.all(),
    ...vars,
  });
}

const nodeService = require('../services/nodeService');

router.get('/admin', async (req, res, next) => {
  try {
    const vms = (await vmService.dbVms()).map(vmService.serializeVm);
    const users = await collections.users.find({}, { projection: { id: 1, username: 1, email: 1, role: 1, suspended: 1, verified: 1, created_at: 1, last_login_at: 1 } }).toArray();
    const running = vms.filter((v) => v.status === 'running').length;
    const totalDisk = vms.reduce((a, v) => a + parseInt(v.disk_size || '0'), 0);
    const recentLogs = await activity.listActivity({ limit: 12 });
    const nodeStats = await nodeService.getNodeLiveStats();
    render(res, 'dashboard', { vms, users, running, totalDisk, recentLogs, usage: vmService.usage(), nodeStats });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/nodes', async (req, res, next) => {
  try {
    const nodeStats = await nodeService.getNodeLiveStats();
    const vms = (await vmService.dbVms()).map(vmService.serializeVm);
    render(res, 'nodes', { nodeStats, vms });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/nodes/status', async (req, res) => {
  try {
    const stats = await nodeService.getNodeLiveStats();
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/admin/servers', async (req, res, next) => {
  try {
    const vms = (await vmService.dbVms()).map(vmService.serializeVm);
    render(res, 'servers', { vms });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/servers/create', async (req, res, next) => {
  try {
    const users = await collections.users.find({}, { projection: { id: 1, username: 1, email: 1 } }).sort({ username: 1 }).toArray();
    render(res, 'create', { osList: vmService.getOsList(), users });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/servers/create', createUpload.fields([{ name: 'image', maxCount: 1 }]), async (req, res) => {
  try {
    const files = req.files || {};
    const ownerId = parseInt(req.body.owner_id || req.user.id, 10);
    const owner = await collections.users.findOne({ id: ownerId });
    if (!owner) return res.status(400).json({ error: 'Owner not found' });
    const data = { ...req.body };
    try { if (data.port_forwards) data.port_forwards = JSON.parse(data.port_forwards); } catch (_) { data.port_forwards = []; }
    if (files.image && files.image[0]) data.upload_image = files.image[0];
    if (files.image && files.image[0]) {
      try { fs2.mkdirSync(config.root + '/data/tmp', { recursive: true }); } catch (_) {}
    }
    const vm = await vmService.create({ user: owner, data });
    // keep the image file if it was a download; clean temp upload if used
    if (data.upload_image) {
      try { fs2.unlinkSync(data.upload_image.path); } catch (_) {}
    }
    return res.json({ ok: true, vm, redirect: `/admin/servers/${vm.id}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/action', async (req, res) => {
  const vm = await vmService.getVm(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Server not found' });
  const { action } = req.body;
  try {
    if (action === 'start') {
      await vmService.start(vm, { user: req.user });
      return res.json({ ok: true, status: 'running' });
    } else if (action === 'stop') {
      const s = await vmService.stop(vm, { user: req.user });
      return res.json({ ok: true, status: s.status });
    } else if (action === 'kill') {
      const s = await vmService.stop(vm, { user: req.user, force: true });
      return res.json({ ok: true, status: s.status });
    } else if (action === 'restart') {
      await vmService.restart(vm, req.user);
      return res.json({ ok: true, status: 'running' });
    } else if (action === 'delete') {
      const s = await vmService.remove(vm, req.user);
      return res.json(s);
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/transfer', express.json(), async (req, res) => {
  const vm = await vmService.getVm(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Server not found' });
  const { owner_id } = req.body;
  if (!owner_id) return res.status(400).json({ error: 'Owner ID is required' });
  try {
    const updated = await vmService.transferOwner(vm, parseInt(owner_id, 10), req.user);
    res.json({ ok: true, vm: vmService.serializeVm(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/servers/:id', async (req, res, next) => {
  try {
    const vm = await vmService.getVm(req.params.id);
    if (!vm) return res.status(404).render('error/404', { code: 404, title: 'Not Found', message: 'Server not found', settings: settings.all(), user: req.user });
    const backups = await backupService.listForVm(vm.id);
    const schedules = await collections.schedules.find({ vm_id: Number(vm.id) }).toArray();
    const subsRaw = await collections.subusers.find({ vm_id: Number(vm.id) }).toArray();
    const userIds = subsRaw.map(s => Number(s.user_id));
    const subUsers = userIds.length ? await collections.users.find({ id: { $in: userIds } }).toArray() : [];
    const userMap = new Map(subUsers.map(u => [u.id, u]));
    const subs = subsRaw.map(s => ({ ...s, username: userMap.get(s.user_id)?.username || '' }));
    const allUsers = await collections.users.find({}, { projection: { id: 1, username: 1, email: 1 } }).sort({ username: 1 }).toArray();
    render(res, 'serverDetail', { vm, backups, schedules, subs, allUsers, uptime: vmService.uptimeSeconds(vm), mem: vmService.memUsage(vm) });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/users', async (req, res, next) => {
  try {
    const users = await collections.users.find().sort({ id: -1 }).toArray();
    const vms = await collections.vms.find({}, { projection: { owner_id: 1 } }).toArray();
    const countMap = {};
    for (const v of vms) countMap[v.owner_id] = (countMap[v.owner_id] || 0) + 1;
    for (const u of users) u.vm_count = countMap[u.id] || 0;
    render(res, 'users', { users });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/users/:id', async (req, res, next) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.redirect('/admin/users');
    const vmsDocs = await collections.vms.find({ owner_id: Number(target.id) }).toArray();
    const vms = vmsDocs.map(vmService.serializeVm);
    const otherDocs = await collections.vms.find({ owner_id: { $ne: Number(target.id) } }).sort({ name: 1 }).toArray();
    const otherOwnerIds = [...new Set(otherDocs.map(v => Number(v.owner_id)))];
    const otherOwners = otherOwnerIds.length ? await collections.users.find({ id: { $in: otherOwnerIds } }).toArray() : [];
    const ownerMap = new Map(otherOwners.map(o => [o.id, o.username]));
    const otherVms = otherDocs.map(v => ({ ...vmService.serializeVm(v), owner_username: ownerMap.get(v.owner_id) || '' }));
    const loginHistory = await activity.listLoginHistory({ user_id: target.id, limit: 100 });
    const logs = await activity.listActivity({ user_id: target.id, limit: 100 });
    render(res, 'userDetail', { target: authService.publicUser(target), vms, otherVms, loginHistory, logs });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/users/:id/assign-vm', express.json(), async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const { vm_id } = req.body;
    if (!vm_id) return res.status(400).json({ error: 'VM ID is required' });
    const vm = await vmService.getVm(vm_id);
    if (!vm) return res.status(404).json({ error: 'Server not found' });
    await vmService.transferOwner(vm, target.id, req.user);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/create', express.json(), async (req, res) => {
  try {
    const user = await authService.createUser({
      username: req.body.username,
      email: req.body.email,
      password: req.body.password,
      name: req.body.name,
      role: req.body.role || 'user',
      verified: true,
    });
    return res.json({ ok: true, user: authService.publicUser(user) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/update', express.json(), async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if ((req.body.suspended === false || req.body.role === 'user' || req.body.root_admin === false) && target.root_admin && (await authService.countAdmins()) <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last admin' });
    }
    const updated = await authService.updateUser(target.id, req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'admin:user_update', details: { target: target.username, ...req.body } });
    return res.json({ ok: true, user: authService.publicUser(updated) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/delete', async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.root_admin && (await authService.countAdmins()) <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin' });
    }
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
    await authService.deleteUser(target.id);
    await activity.logActivity({ user_id: req.user.id, event: 'admin:user_delete', details: { target: target.username } });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/suspend', async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.root_admin && (await authService.countAdmins()) <= 1) return res.status(400).json({ error: 'Cannot suspend the last admin' });
    const suspend = req.body.suspend !== false;
    await authService.updateUser(target.id, { suspended: suspend });
    await activity.logActivity({ user_id: req.user.id, event: suspend ? 'admin:user_suspend' : 'admin:user_unsuspend', details: { target: target.username } });
    return res.json({ ok: true, suspended: suspend });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/impersonate', async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.suspended) return res.status(400).json({ error: 'Cannot impersonate a suspended user' });

    let adminToken = req.cookies?.token;
    if (!adminToken && req.headers?.authorization?.startsWith('Bearer ')) {
      adminToken = req.headers.authorization.slice(7).trim();
    }
    if (!adminToken) {
      adminToken = authService.generateToken(req.user);
    }

    const userToken = authService.generateToken(target);

    res.cookie('vpanel_impersonate_admin', adminToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 86400000,
    });
    res.cookie('token', userToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 86400000,
    });

    await activity.logActivity({
      user_id: req.user.id,
      event: 'auth:impersonate_start',
      details: { admin: req.user.username, target: target.username, target_id: target.id },
      ip: req.ip,
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true, redirect: '/dashboard', target: target.username });
    }
    return res.redirect('/dashboard');
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/admin/activity', async (req, res, next) => {
  try {
    const logs = await activity.listActivity({ limit: 500 });
    render(res, 'activity', { logs });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/settings', (req, res) => {
  const all = settings.all();
  let wallpapers = [];
  const wallpaperCache = path.join(config.root, 'data/wallpapers.json');
  if (fs.existsSync(wallpaperCache)) {
    try { wallpapers = JSON.parse(fs.readFileSync(wallpaperCache, 'utf8')); } catch (_) {}
  }
  render(res, 'settings', { all, wallpapers, updated: req.query.updated || '' });
});

router.post('/admin/settings', express.json(), async (req, res) => {
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'panel.name') continue; // guarded
    settings.set(k, v);
  }
  await activity.logActivity({ user_id: req.user.id, event: 'admin:settings_update', details: Object.keys(body) });
  return res.json({ ok: true, settings: settings.all() });
});

router.post('/admin/settings/general', express.urlencoded({ extended: true }), async (req, res) => {
  const save = (key) => {
    if (req.body[key] !== undefined) settings.set(key, req.body[key]);
  };
  for (const key of [
    'panel.name', 'panel.logo_mode', 'panel.logo_url', 'panel.favicon_name',
    'panel.favicon_mode', 'panel.favicon_url', 'panel.bg_mode', 'panel.bg_color',
    'panel.bg_url', 'panel.bg_cover', 'panel.bg_overlay', 'panel.bg_video_url',
    'panel.music_mode', 'panel.music_url', 'panel.music_youtube', 'panel.music_autoplay',
    'panel.music_loop', 'panel.music_volume', 'panel.navbar_style', 'panel.navbar_transparent',
    'panel.navbar_blur', 'panel.accent', 'panel.theme',
  ]) save(key);
  save('panel.wallpapers_api_key');
  for (const key of ['mail.host', 'mail.port', 'mail.secure', 'mail.user', 'mail.pass', 'mail.from']) save(key);
  for (const key of ['security.allow_register', 'security.require_verify', 'security.force_tfa', 'vm.auto_port_min', 'vm.auto_port_max', 'vm.vnc_port_min', 'vm.vnc_port_max', 'vm.agent_port_min', 'vm.agent_port_max', 'vm.default_memory', 'vm.default_cpus', 'vm.default_disk', 'vm.default_os']) save(key);
  if (req.body.vm_os_list) {
    try {
      settings.set('vm.os_list', JSON.stringify(JSON.parse(req.body.vm_os_list)));
    } catch (_) {}
  }
  activity.logActivity({ user_id: req.user.id, event: 'admin:settings_update' });
  return res.redirect('/admin/settings?updated=1');
});

router.post('/admin/settings/logo', uploadLogo.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  settings.set('panel.logo_mode', 'upload');
  settings.set('panel.logo_file', `/uploads/logo/${req.file.filename}`);
  return res.json({ ok: true, url: `/uploads/logo/${req.file.filename}` });
});

router.post('/admin/settings/favicon', uploadFavicon.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  settings.set('panel.favicon_mode', 'upload');
  settings.set('panel.favicon_file', `/uploads/favicon/${req.file.filename}`);
  return res.json({ ok: true, url: `/uploads/favicon/${req.file.filename}` });
});

router.post('/admin/settings/background', uploadBackground.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const isVideo = /\.(mp4|webm|avi|mov)$/i.test(req.file.filename);
  if (isVideo) {
    settings.set('panel.bg_mode', 'video');
    settings.set('panel.bg_video_file', `/uploads/background/${req.file.filename}`);
  } else {
    settings.set('panel.bg_mode', 'image');
    settings.set('panel.bg_file', `/uploads/background/${req.file.filename}`);
  }
  return res.json({ ok: true, url: `/uploads/background/${req.file.filename}`, mode: isVideo ? 'video' : 'image' });
});

router.post('/admin/settings/music', uploadMusic.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  settings.set('panel.music_mode', 'upload');
  settings.set('panel.music_file', `/uploads/music/${req.file.filename}`);
  return res.json({ ok: true, url: `/uploads/music/${req.file.filename}` });
});

router.post('/admin/settings/logo-clear', (req, res) => {
  settings.set('panel.logo_mode', 'url');
  settings.set('panel.logo_file', '');
  res.json({ ok: true });
});
router.post('/admin/settings/favicon-clear', (req, res) => {
  settings.set('panel.favicon_mode', 'url');
  settings.set('panel.favicon_file', '');
  res.json({ ok: true });
});
router.post('/admin/settings/background-clear', (req, res) => {
  settings.set('panel.bg_mode', 'color');
  settings.set('panel.bg_file', '');
  settings.set('panel.bg_video_file', '');
  res.json({ ok: true });
});
router.post('/admin/settings/music-clear', (req, res) => {
  settings.set('panel.music_mode', 'none');
  settings.set('panel.music_file', '');
  res.json({ ok: true });
});

const wallpaperService = require('../services/wallpaperService');

router.get('/admin/wallpapers', async (req, res) => {
  try {
    const data = await wallpaperService.getWallpapers({
      category: req.query.category,
      page: req.query.page,
      query: req.query.q || req.query.query,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to fetch wallpapers: ' + e.message });
  }
});

router.post('/admin/wallpapers/apply', express.json(), (req, res) => {
  const { url, thumbnail, blur, transparency, overlay } = req.body;
  if (!url) return res.status(400).json({ error: 'No url provided' });
  settings.set('panel.bg_mode', 'image');
  settings.set('panel.bg_url', url);
  if (thumbnail) settings.set('panel.bg_thumb', thumbnail);
  if (blur !== undefined) settings.set('panel.bg_blur', String(blur));
  if (transparency !== undefined) settings.set('panel.bg_transparency', String(transparency));
  if (overlay !== undefined) settings.set('panel.bg_overlay', String(overlay));
  return res.json({ ok: true, message: 'Wallpaper applied successfully' });
});

router.use('/admin/mongodb', require('./webAdminMongo'));
router.use('/admin/storage', require('./webAdminStorage'));
router.use('/admin/network', require('./webAdminNetwork'));
router.use('/admin/billing', require('./webAdminBilling'));
router.use('/admin/updates', require('./webAdminUpdates'));
router.use('/admin/api', require('./webAdminApiManager'));
router.use('/admin/audit', require('./webAdminAudit'));
router.use('/admin/plugins', require('./webAdminPlugins'));

module.exports = router;
