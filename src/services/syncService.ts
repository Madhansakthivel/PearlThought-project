import axios from 'axios';
import { Task, SyncQueueItem, SyncResult, SyncError, BatchSyncRequest, BatchSyncResponse } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

export class SyncService {
  private apiUrl: string;
  
  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
  }


  async sync(): Promise<SyncResult> {
    const SYNC_BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE || '50', 10);

    // 1️⃣ Get all items from sync queue (pending or failed)
    const queueItems: SyncQueueItem[] = await this.db.all(`
      SELECT * FROM sync_queue
      WHERE retry_count < 3
      ORDER BY created_at ASC
    `);

    if (queueItems.length === 0) {
      return {
        success: true,
        synced_items: 0,
        failed_items: 0,
        errors: [],
      };
    }

    let syncedCount = 0;
    let failedCount = 0;
    const errors: SyncError[] = [];

    // 2️⃣ Split into batches
    for (let i = 0; i < queueItems.length; i += SYNC_BATCH_SIZE) {
      const batch = queueItems.slice(i, i + SYNC_BATCH_SIZE);

      for (const item of batch) {
        try {
          // 3️⃣ Determine operation type
          if (item.operation === 'create') {
            await axios.post('https://yourserver.com/api/tasks', item.data);
          } else if (item.operation === 'update') {
            await axios.put(`https://yourserver.com/api/tasks/${item.task_id}`, item.data);
          } else if (item.operation === 'delete') {
            await axios.delete(`https://yourserver.com/api/tasks/${item.task_id}`);
          }

          // 4️⃣ On success → update task + remove queue item
          await this.db.run(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
          await this.taskService.markTaskAsSynced(item.task_id);
          syncedCount++;

        } catch (err: any) {
          // 5️⃣ On failure → increment retry count + store error
          failedCount++;
          const errorMessage = err.message || 'Unknown sync error';

          await this.db.run(
            `UPDATE sync_queue
             SET retry_count = retry_count + 1,
                 error_message = ?
             WHERE id = ?`,
            [errorMessage, item.id]
          );

          errors.push({
            task_id: item.task_id,
            operation: item.operation,
            error: errorMessage,
            timestamp: new Date(),
          });
        }
      }
    }

    // 6️⃣ Return summary
    return {
      success: failedCount === 0,
      synced_items: syncedCount,
      failed_items: failedCount,
      errors,
    };
  }

async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
  const query = `
    INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
    VALUES (?, ?, ?, ?, ?, 0)
  `;
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();

  await this.db.run(query, [id, taskId, operation, JSON.stringify(data), created_at]);
}

private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
  const payload = items.map(item => ({
    operation: item.operation,
    data: item.data
  }));

  try {
    const response = await axios.post(`${this.apiUrl}/sync/batch`, payload);
    const results = response.data.results;

    for (const result of results) {
      if (result.success) {
        await this.updateSyncStatus(result.task_id, 'synced', result.data);
      } else {
        const item = items.find(i => i.task_id === result.task_id);
        if (item) await this.handleSyncError(item, new Error(result.error));
      }
    }

    return response.data;
  } catch (error) {
    for (const item of items) {
      await this.handleSyncError(item, error as Error);
    }
    throw error;
  }
}


private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
  const localUpdated = new Date(localTask.updated_at).getTime();
  const serverUpdated = new Date(serverTask.updated_at).getTime();

  const resolved = localUpdated > serverUpdated ? localTask : serverTask;

  console.log(`[Conflict] Task ${localTask.id} resolved by ${resolved === localTask ? 'local' : 'server'} version.`);
  return resolved;
}


private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
  const now = new Date().toISOString();
  
  await this.db.run(
    `UPDATE tasks
     SET sync_status = ?, last_synced_at = ?, server_id = COALESCE(?, server_id)
     WHERE id = ?`,
    [status, now, serverData?.server_id ?? null, taskId]
  );

  if (status === 'synced') {
    await this.db.run(`DELETE FROM sync_queue WHERE task_id = ?`, [taskId]);
  }
}


private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
  const MAX_RETRIES = 3;
  const newCount = item.retry_count + 1;

  if (newCount >= MAX_RETRIES) {
    await this.updateSyncStatus(item.task_id, 'error');
  }

  await this.db.run(
    `UPDATE sync_queue
     SET retry_count = ?, error_message = ?
     WHERE id = ?`,
    [newCount, error.message, item.id]
  );

  console.error(`Sync failed for ${item.task_id}: ${error.message}`);
}


async checkConnectivity(): Promise<boolean> {
  try {
    const response = await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
    return response.status === 200;
  } catch (error) {
    console.warn('⚠️ Server not reachable:', (error as Error).message);
    return false;
  }
}

}