import { formatDate } from '@rerun/i18n/format'
import { Cron } from 'croner'
import cronstrue from 'cronstrue'

import type { EngineSchedule } from '@/lib/engine/types'

type ScheduleTiming = Pick<EngineSchedule, 'enabled' | 'cron' | 'runAt' | 'timezone' | 'lastRunAt'>

export function humanCron(cron: string): string | null {
    try {
        return cronstrue.toString(cron, { throwExceptionOnParseError: true, verbose: false })
    } catch {
        return null
    }
}

export function scheduleSummary(schedule: Pick<EngineSchedule, 'cron' | 'runAt' | 'timezone'>, locale?: string): string {
    if (schedule.cron) {
        const human = humanCron(schedule.cron)
        return `${human ?? schedule.cron}${schedule.timezone ? ` · ${schedule.timezone}` : ''}`
    }
    if (schedule.runAt) return `once · ${formatDate(schedule.runAt, locale)}`
    return '—'
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function clockTime(hour: number, minute: number, locale?: string): string {
    return formatDate(new Date(2026, 0, 1, hour, minute), locale, { hour: 'numeric', minute: '2-digit' })
}

function clockTimes(hours: string, minute: number, locale?: string): string | null {
    const list = hours.split(',').map(hour => (/^\d+$/.test(hour) ? Number(hour) : NaN))
    if (list.some(hour => Number.isNaN(hour) || hour > 23)) return null
    return list.map(hour => clockTime(hour, minute, locale)).join(', ')
}

// "Every day at 8:15 AM" where cronstrue says "At 08:15 AM": covers the shapes coworkers write and
// falls back to cronstrue for the rest. Times are the cron's own, read in the routine's timezone.
export function routineFrequency(schedule: Pick<EngineSchedule, 'cron' | 'runAt'>, locale?: string): string {
    if (schedule.runAt) return `Once, ${formatDate(schedule.runAt, locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    if (!schedule.cron) return ''
    const fields = schedule.cron.trim().split(/\s+/)
    if (fields.length !== 5) return humanCron(schedule.cron) ?? schedule.cron
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
    const everyMinutes = minute.match(/^\*\/(\d+)$/)
    if (everyMinutes && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return `Every ${everyMinutes[1]} minutes`
    const at = /^\d+$/.test(minute) && Number(minute) < 60 ? clockTimes(hour, Number(minute), locale) : null
    if (at && month === '*') {
        if (dayOfMonth === '*' && dayOfWeek === '*') return `Every day at ${at}`
        if (dayOfMonth === '*' && dayOfWeek === '1-5') return `Weekdays at ${at}`
        if (dayOfMonth === '*' && /^[0-6]$/.test(dayOfWeek)) return `Every ${WEEKDAYS[Number(dayOfWeek)]} at ${at}`
        if (/^\d+$/.test(dayOfMonth) && dayOfWeek === '*') return `Monthly on day ${dayOfMonth} at ${at}`
    }
    return humanCron(schedule.cron) ?? schedule.cron
}

// Mirrors nextRunAt in apps/engine/src/schedules/cron.ts: the engine never sends it over HTTP.
export function nextRunAt(schedule: ScheduleTiming, now: Date): string | null {
    if (!schedule.enabled) return null
    if (schedule.runAt) return schedule.lastRunAt ? null : schedule.runAt
    if (!schedule.cron) return null
    try {
        const next = new Cron(schedule.cron, schedule.timezone ? { timezone: schedule.timezone } : undefined).nextRun(now)
        return next ? next.toISOString() : null
    } catch {
        return null
    }
}
