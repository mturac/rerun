'use client'

import { listRunnerApprovalsAction } from '@/app/api/_actions/local-runner.actions'
import { useEffect, useState } from 'react'

const POLL_MS = 60 * 1000

// The engine cannot push to the browser, so the count of runner approvals waiting on a decision is
// read on mount, every minute while the tab is visible, and whenever the tab comes back.
export function useRunnerApprovalCount(enabled: boolean): number {
    const [count, setCount] = useState(0)

    useEffect(() => {
        if (!enabled) return
        let cancelled = false
        const tick = async () => {
            if (document.visibilityState !== 'visible') return
            const result = await listRunnerApprovalsAction().catch(() => null)
            if (!cancelled && result?.ok) setCount(result.approvals.length)
        }
        const onVisible = () => void tick()
        onVisible()
        const timer = setInterval(onVisible, POLL_MS)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
            cancelled = true
            clearInterval(timer)
            document.removeEventListener('visibilitychange', onVisible)
        }
    }, [enabled])

    return enabled ? count : 0
}
