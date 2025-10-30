import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';
import dns from 'dns';
import crypto from 'crypto';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);


router.post('/sync', async (req: Request, res: Response) => {
  try {

    await new Promise<void>((resolve, reject) => {
      dns.lookup('google.com', (err) => (err ? reject(err) : resolve()));
    });

    const result = await syncService.sync();

    res.status(200).json({
      message: result.success ? 'Sync completed successfully' : 'Sync completed with some errors',
      result,
    });
  } catch (error) {
    console.error('Sync failed:', error);
    res.status(500).json({ error: 'No internet connection or sync process failed' });
  }
});

router.get('/status', async (req, res) => {
  try {
    const [pending] = await db.get(`SELECT COUNT(*) as count FROM sync_queue`);
    const [lastSync] = await db.get(`
      SELECT MAX(last_synced_at) as last_sync FROM tasks WHERE last_synced_at IS NOT NULL
    `);

    const online = await syncService.checkConnectivity();

    res.json({
      pending_sync: pending.count,
      last_sync: lastSync.last_sync || null,
      online
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});


  function verifyChecksum(items: any[], checksum: string): boolean {
  const dataString = items.map(i => i.id + JSON.stringify(i.data)).join('');
  const computed = crypto.createHash('sha256').update(dataString).digest('hex');
  return computed === checksum;
}

router.post('/batch', async (req: Request, res: Response) => {
  try {
    const { items, checksum } = req.body;

    if (!verifyChecksum(items, checksum)) {
      return res.status(400).json({ error: 'Checksum verification failed' });
    }

    const results: any[] = [];

    for (const item of items) {
      try {
        let resultData;
        if (item.operation === 'create') {
          resultData = await taskService.createTask(item.data);
        } else if (item.operation === 'update') {
          resultData = await taskService.updateTask(item.data.id, item.data);
        } else if (item.operation === 'delete') {
          const deleted = await taskService.deleteTask(item.data.id);
          resultData = { deleted };
        }

        results.push({ ...item, success: true, data: resultData });
      } catch (err) {
        results.push({ ...item, success: false, error: (err as Error).message });
      }
    }

    res.json({
      success: true,
      results,
      synced_items: results.filter(r => r.success).length,
      failed_items: results.filter(r => !r.success).length
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error during batch sync' });
  }
});


router.get('/health', async (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});


  return router;
}