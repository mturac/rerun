'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { removeMyTemplateAgentAction } from '@/app/api/_actions/expert-capture.actions'
import {
    createMyTemplateDraftAction,
    deleteMyTemplateAction,
    getMyTemplateAction,
    listMyTemplatesAction,
    submitMyTemplateAction,
    updateMyTemplateAction,
    withdrawMyTemplateAction,
} from '@/app/api/_actions/expert-template.actions'
import type { ExpertTemplate, ExpertTemplateDetail, TemplateAuthorInput } from '@/lib/templates/expert'

type ListResult = Awaited<ReturnType<typeof listMyTemplatesAction>>

// Fetched when the panel opens, reloaded after every write: the list is short and the panel is modal,
// so there is nothing to keep in sync while it is closed. `templates === null` means loading, and so
// does `detail === null` while an id is selected.
export function useMyTemplates(open: boolean, selectedId: string | null) {
    const t = useTranslations('templates.expert.toasts')
    const [templates, setTemplates] = useState<ExpertTemplate[] | null>(null)
    const [detail, setDetail] = useState<ExpertTemplateDetail | null>(null)

    const apply = useCallback((result: ListResult) => {
        if (!result.ok) {
            toast.error(result.error)
            setTemplates([])
            return
        }
        setTemplates(result.templates)
    }, [])

    const load = useCallback(() => listMyTemplatesAction().then(apply), [apply])

    // Which template the last fetch was for: a slower answer for a template the author has already
    // moved away from is dropped instead of replacing the one on screen.
    const requestedRef = useRef<string | null>(null)

    const loadDetail = useCallback((id: string) => {
        requestedRef.current = id
        return getMyTemplateAction(id).then(result => {
            if (requestedRef.current !== id) return
            if (!result.ok) {
                toast.error(result.error)
                return
            }
            setDetail(result.template)
        })
    }, [])

    useEffect(() => {
        if (open) void load()
    }, [open, load])

    useEffect(() => {
        if (selectedId) void loadDetail(selectedId)
    }, [selectedId, loadDetail])

    // Every write can change both views: the row (title, status) and the document the editor holds.
    const reload = useCallback(async () => {
        await load()
        if (selectedId) await loadDetail(selectedId)
    }, [load, loadDetail, selectedId])

    const create = useCallback(
        async (title: string): Promise<string | null> => {
            const result = await createMyTemplateDraftAction(title)
            if (!result.ok) {
                toast.error(result.error)
                return null
            }
            await load()
            return result.id
        },
        [load],
    )

    const save = useCallback(
        async (id: string, values: TemplateAuthorInput): Promise<boolean> => {
            const result = await updateMyTemplateAction({ id, ...values })
            if (!result.ok) {
                toast.error(result.error)
                return false
            }
            toast.success(t('saved'))
            await reload()
            return true
        },
        [reload, t],
    )

    const submit = useCallback(
        async (id: string): Promise<boolean> => {
            const result = await submitMyTemplateAction(id)
            if (!result.ok) {
                toast.error(result.error)
                return false
            }
            toast.success(t('submitted'))
            await reload()
            return true
        },
        [reload, t],
    )

    const withdraw = useCallback(
        async (id: string): Promise<boolean> => {
            const result = await withdrawMyTemplateAction(id)
            if (!result.ok) {
                toast.error(result.error)
                return false
            }
            await reload()
            return true
        },
        [reload],
    )

    const remove = useCallback(
        async (id: string): Promise<boolean> => {
            const result = await deleteMyTemplateAction(id)
            if (!result.ok) {
                toast.error(result.error)
                return false
            }
            await load()
            return true
        },
        [load],
    )

    // Capture and removal rewrite the row out of band, so the panel picks the change up the same way
    // it does after a save: by reloading what it renders from.
    const removeAgent = useCallback(
        async (templateId: string, agentKey: string): Promise<boolean> => {
            const result = await removeMyTemplateAgentAction({ templateId, agentKey })
            if (!result.ok) {
                toast.error(result.error)
                return false
            }
            await reload()
            return true
        },
        [reload],
    )

    // Matched on identity rather than cleared on selection: the editor never renders the previous
    // template's document under the newly selected id, without a setState inside an effect.
    return { templates, detail: detail?.id === selectedId ? detail : null, create, save, submit, withdraw, remove, removeAgent, reload }
}
