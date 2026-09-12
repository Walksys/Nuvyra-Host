const express = require("express");
const router = express.Router();
const { requireAdmin } = require("../middleware/auth");
const { collections, settings } = require("../lib/db");
const vmService = require("../services/vmService");
const nodeService = require("../services/nodeService");
const resourceService = require("../services/resourceService");
const activity = require("../services/activityService");
const config = require("../lib/config");

router.use(requireAdmin);

function render(res, view, vars = {}) {
  res.render("admin/" + view, {
    page: "admin-resources",
    user: res.req.user,
    settings: settings.all(),
    ...vars,
  });
}

router.get("/", async (req, res, next) => {
  try {
    const nodeStats = await nodeService.getNodeLiveStats();
    const rawVms = await collections.vms.find({}).sort({ id: -1 }).toArray();
    const users = await collections.users.find({}, { projection: { id: 1, username: 1, email: 1 } }).toArray();
    const userMap = {};
    for (const u of users) userMap[u.id] = u;

    const vms = rawVms.map(v => {
      const serialized = vmService.serializeVm(v);
      serialized.owner = userMap[v.owner_id] || { username: "Admin", email: "admin@nuvyra.local" };
      serialized.isRunning = vmService.isRunning(v);
      return serialized;
    });

    // Calculate total allocated resources across all VMs
    let totalAllocatedCores = 0;
    let totalAllocatedRAM_MB = 0;
    let totalAllocatedDisk_GB = 0;
    let totalAllocatedBandwidth = 0;
    let totalAllocatedIPv4 = 0;

    for (const vm of vms) {
      totalAllocatedCores += parseInt(vm.cpus || "1", 10);
      totalAllocatedRAM_MB += parseInt(vm.memory || "2048", 10);
      totalAllocatedDisk_GB += parseInt(String(vm.disk_size || "20").replace(/\D/g, "") || "20", 10);
      totalAllocatedBandwidth += parseInt(vm.bandwidth || "100", 10);
      totalAllocatedIPv4 += parseInt(vm.ipv4_count || "1", 10);
    }

    const hostCores = nodeStats.cpu?.cores_count || 4;
    const hostRamMB = nodeStats.memory?.total_mb || 8192;
    const hostDiskGB = parseFloat(nodeStats.disk?.total_gb) || 100;

    const usage = {
      cpuCores: {
        allocated: totalAllocatedCores,
        limit: hostCores,
        percentage: Math.min(100, Math.round((totalAllocatedCores / (hostCores || 1)) * 100)),
        livePercent: nodeStats.cpu?.percent || 0
      },
      ram: {
        allocatedMb: totalAllocatedRAM_MB,
        allocatedGb: (totalAllocatedRAM_MB / 1024).toFixed(1),
        limitMb: hostRamMB,
        limitGb: (hostRamMB / 1024).toFixed(1),
        percentage: Math.min(100, Math.round((totalAllocatedRAM_MB / (hostRamMB || 1)) * 100)),
        livePercent: nodeStats.memory?.percent || 0,
        liveUsedMb: nodeStats.memory?.used_mb || 0
      },
      disk: {
        allocatedGb: totalAllocatedDisk_GB,
        limitGb: hostDiskGB.toFixed(1),
        percentage: Math.min(100, Math.round((totalAllocatedDisk_GB / (hostDiskGB || 1)) * 100)),
        livePercent: nodeStats.disk?.percent || 0,
        liveUsedGb: nodeStats.disk?.used_gb || "0"
      },
      bandwidth: {
        allocatedGb: totalAllocatedBandwidth,
        limitGb: 5000,
        percentage: Math.min(100, Math.round((totalAllocatedBandwidth / 5000) * 100))
      },
      ipv4: {
        allocated: totalAllocatedIPv4,
        limit: 10,
        percentage: Math.min(100, Math.round((totalAllocatedIPv4 / 10) * 100))
      }
    };

    render(res, "resources", {
      nodeStats,
      vms,
      usage,
      page: "admin-resources"
    });
  } catch (err) {
    next(err);
  }
});

router.get("/api/stats", async (req, res) => {
  try {
    const nodeStats = await nodeService.getNodeLiveStats();
    res.json({ ok: true, stats: nodeStats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
