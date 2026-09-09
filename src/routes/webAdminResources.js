const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { collections, settings } = require('../lib/db');
const vmService = require('../services/vmService');
const nodeService = require('../services/nodeService');
const activity = require('../services/activityService');
const config = require('../lib/config');
const { render } = require('./webAdmin');

router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const nodeStats = await nodeService.getNodeLiveStats();
    const vms = (await vmService.dbVms()).map(vmService.serializeVm);
    
    // Calculate total allocated resources across all VMs
    let totalAllocatedCores = 0;
    let totalAllocatedRAM = 0;
    let totalAllocatedDisk = 0;
    let totalAllocatedBandwidth = 0;
    let totalAllocatedIPv4 = 0;
    
    for (const vm of vms) {
      totalAllocatedCores += parseInt(vm.cpus || '0');
      totalAllocatedRAM += parseInt(vm.memory || '0');
      totalAllocatedDisk += parseInt(vm.disk_size || '0');
      // Bandwidth might be stored differently, using a default if not present
      totalAllocatedBandwidth += parseInt(vm.bandwidth || '0');
      totalAllocatedIPv4 += (vm.ipv4_count || 1); // Assuming at least 1 IP if not specified
    }
    
    // Get node limits (total available resources)
    const nodeLimits = {
      cpuCores: nodeStats.cpu_cores || 8,
      cpuLimit: nodeStats.cpu_limit || 100,
      ram: nodeStats.ram_total || 32,
      disk: nodeStats.disk_total || 500,
      bandwidth: nodeStats.bandwidth_total || 10,
      ipv4: nodeStats.ipv4_total || 5
    };
    
    // Calculate usage percentages
    const usage = {
      cpuCores: {
        allocated: totalAllocatedCores,
        limit: nodeLimits.cpuCores,
        percentage: nodeLimits.cpuCores > 0 ? (totalAllocatedCores / nodeLimits.cpuCores) * 100 : 0
      },
      cpuLimit: {
        allocated: totalAllocatedCores, // This is actually used cores, not percentage
        limit: nodeLimits.cpuLimit,
        percentage: nodeLimits.cpuLimit > 0 ? (totalAllocatedCores / nodeLimits.cpuCores) * (nodeLimits.cpuLimit / 100) : 0
      },
      ram: {
        allocated: totalAllocatedRAM,
        limit: nodeLimits.ram,
        percentage: nodeLimits.ram > 0 ? (totalAllocatedRAM / nodeLimits.ram) * 100 : 0
      },
      disk: {
        allocated: totalAllocatedDisk,
        limit: nodeLimits.disk,
        percentage: nodeLimits.disk > 0 ? (totalAllocatedDisk / nodeLimits.disk) * 100 : 0
      },
      bandwidth: {
        allocated: totalAllocatedBandwidth,
        limit: nodeLimits.bandwidth,
        percentage: nodeLimits.bandwidth > 0 ? (totalAllocatedBandwidth / nodeLimits.bandwidth) * 100 : 0
      },
      ipv4: {
        allocated: totalAllocatedIPv4,
        limit: nodeLimits.ipv4,
        percentage: nodeLimits.ipv4 > 0 ? (totalAllocatedIPv4 / nodeLimits.ipv4) * 100 : 0
      }
    };
    
    render(res, 'resources', { 
      nodeStats, 
      vms, 
      nodeLimits,
      usage,
      page: 'admin-resources'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;