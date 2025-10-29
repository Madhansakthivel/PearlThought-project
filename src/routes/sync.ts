import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';
import dns from 'dns';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);


// POST /api/sync → Trigger manual sync
router.post('/sync', async (req: Request, res: Response) => {
  try {
    // 1️⃣ Check if online (basic DNS check)
    await new Promise<void>((resolve, reject) => {
      dns.lookup('google.com', (err) => (err ? reject(err) : resolve()));
    });

    // 2️⃣ Run main sync
    const result = await syncService.sync();

    // 3️⃣ Respond with structured result
    res.status(200).json({
      message: result.success ? 'Sync completed successfully' : 'Sync completed with some errors',
      result,
    });
  } catch (error) {
    console.error('Sync failed:', error);
    res.status(500).json({ error: 'No internet connection or sync process failed' });
  }
});

  // Check sync status
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


  // Batch sync endpoint (for server-side)
router.post('/batch', async (req: Request, res: Response) => {
  try {
    const batch = req.body; // [{ operation: 'create' | 'update' | 'delete', data: Task }]
    const results: any[] = [];

    for (const item of batch) {
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

        results.push({
          task_id: item.data.id,
          operation: item.operation,
          success: true,
          data: resultData,
        });
      } catch (err) {
        results.push({
          task_id: item.data.id,
          operation: item.operation,
          success: false,
          error: (err as Error).message,
        });
      }
    }

    res.status(200).json({
      success: true,
      results,
      synced_items: results.filter(r => r.success).length,
      failed_items: results.filter(r => !r.success).length,
    });
  } catch (error) {
    console.error('Batch sync error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during batch sync',
    });
  }
});


  // Health check endpoint
router.get('/health', async (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});


  return router;
}