import axios from 'axios';
import { Task, SyncQueueItem, SyncResult, SyncError, BatchSyncRequest, BatchSyncResponse } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';
import crypto from 'crypto';



export class SyncService {
  private apiUrl: string;

  private calculateChecksum(items: SyncQueueItem[]): string {
  const dataString = items
    .map(item => item.id + JSON.stringify(item.data))
    .join('');

  return crypto.createHash('sha256').update(dataString).digest('hex');
}

  
  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
  }


  async sync(): Promise<SyncResult> {
    const SYNC_BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE || '50', 10);

    const queueItems: SyncQueueItem[] = await this.db.all(`
      SELECT * FROM sync_queue
      WHERE attempts < 3
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

    for (let i = 0; i < queueItems.length; i += SYNC_BATCH_SIZE) {
      const batch = queueItems.slice(i, i + SYNC_BATCH_SIZE);

      for (const item of batch) {
        try {
          if (item.operation === 'create') {
            await axios.post('https://yourserver.com/api/tasks', item.data);
          } else if (item.operation === 'update') {
            await axios.put(`https://yourserver.com/api/tasks/${item.task_id}`, item.data);
          } else if (item.operation === 'delete') {
            await axios.delete(`https://yourserver.com/api/tasks/${item.task_id}`);
          }
          await this.db.run(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
          await this.taskService.markTaskAsSynced(item.task_id);
          syncedCount++;

        } catch (err: any) {

          failedCount++;
          const errorMessage = err.message || 'Unknown sync error';

          await this.db.run(
            `UPDATE sync_queue
             SET attempts = attempts + 1,
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
  try {

    const checksum = this.calculateChecksum(items);

    const payload = {
      checksum,
      items
    };


    const response = await axios.post(`${this.apiUrl}/batch`, payload);


    return response.data;
  } catch (error) {
    throw new Error('Batch processing failed: ' + (error as Error).message);
  }
}



private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
  const localTime = new Date(localTask.updated_at).getTime();
  const serverTime = new Date(serverTask.updated_at).getTime();

  if (localTime > serverTime) return localTask;
  if (serverTime > localTime) return serverTask;

  const priority: Record<'create' | 'update' | 'delete', number> = {
    create: 1,
    update: 2,
    delete: 3,
  };

  const localPriority = priority['update'];
  const serverPriority = priority['update'];

  if (localTask.is_deleted && !serverTask.is_deleted) return localTask;
  if (serverTask.is_deleted && !localTask.is_deleted) return serverTask;

  return localTask;
}




private async updateSyncStatus(
  taskId: string,
  status: 'pending' | 'in-progress' | 'synced' | 'error' | 'failed',
  serverData?: Partial<Task>
): Promise<void> {
  const now = new Date().toISOString();

  await this.db.run(
    `
      UPDATE tasks
      SET 
        sync_status = ?,
        server_id = COALESCE(?, server_id),
        last_synced_at = ?
      WHERE id = ?
    `,
    [status, serverData?.server_id ?? null, now, taskId]
  );

  if (status === 'synced' || status === 'failed') {
    await this.db.run(`DELETE FROM sync_queue WHERE task_id = ?`, [taskId]);
  }
}



private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
  const newCount = item.retry_count + 1;
  const errorMsg = error.message;

  if (newCount >= 3) {
    await this.db.run(`
      INSERT INTO dead_letter_queue (id, task_id, operation, data, error_message)
      VALUES (?, ?, ?, ?, ?)
    `, [item.id, item.task_id, item.operation, JSON.stringify(item.data), errorMsg]);

    await this.updateSyncStatus(item.task_id, 'failed');
  } else {

    await this.db.run(`
      UPDATE sync_queue
      SET retry_count = ?, error_message = ?
      WHERE id = ?
    `, [newCount, errorMsg, item.id]);

    await this.updateSyncStatus(item.task_id, 'error');
  }
}



async checkConnectivity(): Promise<boolean> {
  try {
    const response = await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
    return response.status === 200;
  } catch (error) {
    console.warn('Server not reachable:', (error as Error).message);
    return false;
  }
}

}