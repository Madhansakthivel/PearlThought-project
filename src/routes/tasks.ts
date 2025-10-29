import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { SyncService } from '../services/syncService';
import { Database } from '../db/database';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Get all tasks
  router.get('/', async (req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      res.json(tasks);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // Create task
router.post('/', async (req: Request, res: Response) => {
  try {
    const { title, description } = req.body;

    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Title is required and must be a string' });
    }

    const createdTask = await taskService.createTask({ title, description });

    res.status(201).json({
      ...createdTask,
      created_at: createdTask.created_at.toISOString(),
      updated_at: createdTask.updated_at.toISOString(),
    });
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

  // Update task
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, completed } = req.body;

    if (title && typeof title !== 'string') {
      return res.status(400).json({ error: 'Invalid title' });
    }
    if (description && typeof description !== 'string') {
      return res.status(400).json({ error: 'Invalid description' });
    }
    if (completed !== undefined && typeof completed !== 'boolean') {
      return res.status(400).json({ error: 'Invalid completed value' });
    }

    const updatedTask = await taskService.updateTask(id, { title, description, completed });


    if (!updatedTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.status(200).json({
      ...updatedTask,
      created_at: updatedTask.created_at.toISOString(),
      updated_at: updatedTask.updated_at.toISOString(),
    });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

  // Delete task
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // 1️⃣ Call service
    const deleted = await taskService.deleteTask(id);

    // 2️⃣ Handle not found
    if (!deleted) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // 3️⃣ Return success response
    res.status(200).json({ message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

  return router;
}