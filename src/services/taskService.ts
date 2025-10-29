import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';

export class TaskService {
  constructor(private db: Database) {}


  async createTask(taskData: Partial<Task>): Promise<Task> {
    const id = uuidv4();
    const now = new Date();

    const newTask: Task = {
      id,
      title: taskData.title ?? '',
      description: taskData.description ?? '',
      completed: false,
      is_deleted: false,
      created_at: now,
      updated_at: now,
      sync_status: 'pending',
      server_id: undefined,
      last_synced_at: undefined,
    };


    const insertQuery = `
      INSERT INTO tasks (
        id, title, description, completed, is_deleted,
        created_at, updated_at, sync_status, server_id, last_synced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      newTask.id,
      newTask.title,
      newTask.description,
      newTask.completed ? 1 : 0,
      newTask.is_deleted ? 1 : 0,
      newTask.created_at.toISOString(),
      newTask.updated_at.toISOString(),
      newTask.sync_status,
      newTask.server_id ?? null,
      newTask.last_synced_at ? newTask.last_synced_at.toISOString() : null,
    ];

    await this.db.run(insertQuery, params);

    // Add entry to sync queue
    const queueInsert = `
      INSERT INTO sync_queue (operation_type, task_snapshot, attempts, status)
      VALUES (?, ?, ?, ?)
    `;
    await this.db.run(queueInsert, [
      'create',
      JSON.stringify({
        ...newTask,
        created_at: newTask.created_at.toISOString(),
        updated_at: newTask.updated_at.toISOString(),
      }),
      0,
      'pending',
    ]);

    return newTask;
  }



  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    // 1️⃣ Check if task exists
    const existing = await this.db.get('SELECT * FROM tasks WHERE id = ? AND is_deleted = 0', [id]);
    if (!existing) {
      return null;
    }

    // 2️⃣ Prepare updated fields
    const now = new Date();
    const updatedTask: Task = {
      ...existing,
      ...updates,
      updated_at: now,
      sync_status: 'pending',
    };

    // 3️⃣ Update in database
    const updateQuery = `
      UPDATE tasks
      SET title = ?, description = ?, completed = ?, updated_at = ?, sync_status = ?
      WHERE id = ?
    `;

    const params = [
      updatedTask.title,
      updatedTask.description,
      updatedTask.completed ? 1 : 0,
      updatedTask.updated_at.toISOString(),
      updatedTask.sync_status,
      id,
    ];

    await this.db.run(updateQuery, params);

    // 4️⃣ Add to sync queue
    const queueInsert = `
      INSERT INTO sync_queue (operation_type, task_snapshot, attempts, status)
      VALUES (?, ?, ?, ?)
    `;
    await this.db.run(queueInsert, [
      'update',
      JSON.stringify({
        ...updatedTask,
        created_at: updatedTask.created_at instanceof Date
          ? updatedTask.created_at.toISOString()
          : updatedTask.created_at,
        updated_at: updatedTask.updated_at.toISOString(),
      }),
      0,
      'pending',
    ]);

    // 5️⃣ Return updated task
    return {
      ...updatedTask,
      created_at: new Date(existing.created_at),
      updated_at: now,
    };
  }

async deleteTask(id: string): Promise<boolean> {
    // 1️⃣ Check if task exists
    const existing = await this.db.get('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return false; // not found
    }

    // 2️⃣ Soft delete: mark is_deleted = true
    const now = new Date();
    const updateQuery = `
      UPDATE tasks
      SET is_deleted = 1, updated_at = ?, sync_status = 'pending'
      WHERE id = ?
    `;
    await this.db.run(updateQuery, [now.toISOString(), id]);

    // 3️⃣ Prepare deleted snapshot for sync queue
    const deletedSnapshot: Task = {
      ...existing,
      is_deleted: true,
      updated_at: now,
      sync_status: 'pending',
    };

    // 4️⃣ Add to sync queue
    const queueInsert = `
      INSERT INTO sync_queue (operation_type, task_snapshot, attempts, status)
      VALUES (?, ?, ?, ?)
    `;
    await this.db.run(queueInsert, [
      'delete',
      JSON.stringify({
        ...deletedSnapshot,
        created_at: new Date(existing.created_at).toISOString(),
        updated_at: now.toISOString(),
      }),
      0,
      'pending',
    ]);

    // 5️⃣ Return success
    return true;
  }

async getTask(id: string): Promise<Task | null> {
  // 1️⃣ Query database for task by ID
  const query = `SELECT * FROM tasks WHERE id = ?`;
  const row = await this.db.get(query, [id]);

  // 2️⃣ If not found or soft-deleted, return null
  if (!row || row.is_deleted) {
    return null;
  }

  // 3️⃣ Convert timestamps to Date objects
  const task: Task = {
    ...row,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    completed: !!row.completed,
    is_deleted: !!row.is_deleted,
  };

  return task;
}

async getAllTasks(): Promise<Task[]> {
    // 1️⃣ Query database for all non-deleted tasks
    const query = `
      SELECT * FROM tasks
      WHERE is_deleted = 0
      ORDER BY updated_at DESC
    `;
    const rows = await this.db.all(query);

    // 2️⃣ Convert string timestamps to Date objects
    const tasks: Task[] = rows.map((row: any) => ({
      ...row,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
      completed: !!row.completed,
      is_deleted: !!row.is_deleted,
    }));

    return tasks;
  }

  async getTasksNeedingSync(): Promise<Task[]> {
  // 1️⃣ Query database for all tasks with pending or error sync_status
  const query = `
    SELECT * FROM tasks
    WHERE sync_status IN ('pending', 'error')
      AND is_deleted = 0
    ORDER BY updated_at ASC
  `;
  const rows = await this.db.all(query);

  // 2️⃣ Convert timestamps to Date objects
  const tasks: Task[] = rows.map((row: any) => ({
    ...row,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    completed: !!row.completed,
    is_deleted: !!row.is_deleted,
  }));

  // 3️⃣ Return tasks that still need sync
  return tasks;
}

async markTaskAsSynced(taskId: string): Promise<void> {
  const query = `
    UPDATE tasks
    SET
      sync_status = 'synced',
      last_synced_at = ?,
      updated_at = ?
    WHERE id = ?
  `;
  const now = new Date().toISOString();

  await this.db.run(query, [now, now, taskId]);
}


}