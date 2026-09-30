import { tool } from 'ai'
import { z } from 'zod'

// Todo item schema: the shape the tool RETURNS and the UI renders. `id` and
// `timestamp` are always set here — the server fills them when the model
// leaves them out (see todoItemInputSchema).
export const todoItemSchema = z.object({
  id: z.string().describe('Unique identifier for the todo item'),
  content: z.string().describe('The task description'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe('Current status of the task'),
  priority: z
    .enum(['high', 'medium', 'low'])
    .default('medium')
    .describe('Priority level of the task'),
  timestamp: z.string().describe('ISO timestamp when the todo was created')
})

export type TodoItem = z.infer<typeof todoItemSchema>

// What the MODEL must send. `id` and `timestamp` are bookkeeping the server
// can fill, so they are optional here: with both required, models routinely
// omitted `timestamp` (13 of the 14 schema failures stored on prod/staging/lab
// by 2026-09-29, e.g. kimi-k2.6 on a lab quality turn) and the whole call
// failed validation — and one retry that added timestamps dropped `id`.
export const todoItemInputSchema = todoItemSchema.extend({
  id: z
    .string()
    .optional()
    .describe(
      'Identifier for the todo item. Optional: defaults to its 1-based position in the list'
    ),
  timestamp: z
    .string()
    .optional()
    .describe('Optional: filled in by the server when omitted')
})

export type TodoItemInput = z.infer<typeof todoItemInputSchema>

// Schema for todo write tool
export const todoWriteInputSchema = z.object({
  todos: z.array(todoItemInputSchema).describe('The complete list of todos'),
  progressMessage: z
    .string()
    .optional()
    .describe('A brief message about the current progress')
})

/**
 * Fill the server-owned fields of each todo: `id` defaults to the item's
 * 1-based position, `timestamp` to the creation time already recorded for
 * that id in this session (a todoWrite call rewrites the whole list), else
 * `now`. Values the model did send are kept.
 */
export function completeTodos(
  todos: TodoItemInput[],
  previous: readonly TodoItem[],
  now: string
): TodoItem[] {
  const createdAt = new Map(previous.map(t => [t.id, t.timestamp]))
  return todos.map((todo, index) => {
    const id = todo.id || String(index + 1)
    return {
      ...todo,
      id,
      priority: todo.priority || 'medium',
      timestamp: todo.timestamp || createdAt.get(id) || now
    }
  })
}

// Create todo tools with session-scoped storage
export function createTodoTools() {
  // Session-scoped todos storage - isolated per tool instance
  let sessionTodos: TodoItem[] = []
  const todoWrite = tool({
    description:
      'Create or update todos to track progress on complex tasks. Use this to maintain a list of action items. The response includes completedCount and totalCount to verify task completion.',
    inputSchema: todoWriteInputSchema,
    execute: async ({ todos, progressMessage }) => {
      // Update session todos, filling id/priority/timestamp where omitted
      sessionTodos = completeTodos(
        todos,
        sessionTodos,
        new Date().toISOString()
      )

      // Calculate progress
      const completedCount = todos.filter(t => t.status === 'completed').length
      const totalCount = todos.length

      return {
        success: true,
        message: progressMessage || `Updated ${totalCount} todos`,
        completedCount,
        totalCount,
        todos: sessionTodos
      }
    }
  })

  return { todoWrite }
}
