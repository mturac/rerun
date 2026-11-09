import { sessionExecutionSchema, type SessionExecution } from './types'

export function sessionExecutionOf(response: Response): SessionExecution | null {
    const value = response.headers.get('x-session-execution')
    return value === null ? null : sessionExecutionSchema.parse(JSON.parse(value))
}
