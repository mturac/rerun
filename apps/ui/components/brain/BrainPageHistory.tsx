'use client'

import { readBrainRevisionAction } from '@/app/api/_actions/brain.actions'
import { BrainEditor } from '@/components/brain/editor/BrainEditor'
import { PageColumn } from '@/components/brain/BrainPageParts'
import { BrainTopBar } from '@/components/brain/BrainTopBar'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { brainAuthorLabel, isCardType } from '@/lib/brain/labels'
import { BRAIN_PAGE_ICONS } from '@/lib/brain/page-icons'
import { ArrowLeftIcon } from '@/lib/icons'
import { fullDateTime, shortRelativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { BrainPage, BrainRevision } from '@rerun/contracts'
import { useLocale } from 'next-intl'
import { useEffect, useState } from 'react'

type BrainPageHistoryProps = {
    page: BrainPage
    revisions: BrainRevision[]
    titles: Map<string, string>
    onBack: () => void
    onOpenPage: (slug: string) => void
    onOpenFile: (path: string) => void
    onRestore: (revisionId: string) => Promise<void>
}

function PreviewSkeleton() {
    return (
        <PageColumn>
            <Skeleton className="h-8 w-1/2" />
            <div className="mt-8 space-y-3">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
            </div>
        </PageColumn>
    )
}

// Every version of a page, newest first, as Notion lays its history out: what the page said on the
// left, who changed it and when on the right.
export function BrainPageHistory({ page, revisions, titles, onBack, onOpenPage, onOpenFile, onRestore }: BrainPageHistoryProps) {
    const locale = useLocale()
    const [selectedId, setSelectedId] = useState<string | null>(revisions[0]?.id ?? null)
    const [preview, setPreview] = useState<{ id: string; content: string } | null>(null)
    const [restoring, setRestoring] = useState(false)

    const selected = revisions.find(revision => revision.id === selectedId) ?? null
    const isCurrent = selected !== null && selected.id === revisions[0]?.id && selected.hash === page.hash

    useEffect(() => {
        if (!selectedId) return
        let cancelled = false
        readBrainRevisionAction(page.slug, selectedId).then(found => {
            if (!cancelled) setPreview({ id: selectedId, content: found?.content ?? '' })
        })
        return () => {
            cancelled = true
        }
    }, [page.slug, selectedId])

    // Escape steps back to the page rather than closing the whole Brain.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || document.querySelector('[role="alertdialog"]')) return
            event.preventDefault()
            onBack()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [onBack])

    const restore = async () => {
        if (!selected) return
        setRestoring(true)
        await onRestore(selected.id)
        setRestoring(false)
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={[{ label: isCardType(page.type) ? 'Company' : 'Pages' }, { label: page.title, icon: BRAIN_PAGE_ICONS[page.type], onClick: onBack }, { label: 'Version history' }]}>
                <Button size="sm" variant="ghost" onClick={onBack}>
                    <ArrowLeftIcon /> Back to page
                </Button>
            </BrainTopBar>

            <div className="flex min-h-0 flex-1 border-t border-border max-sm:flex-col-reverse">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {selected && (
                        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm">
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                {isCurrent ? 'Current version' : `Version from ${fullDateTime(selected.createdAt, locale)}`}
                            </span>
                            {!isCurrent && (
                                <ConfirmDialog
                                    title="Restore this version?"
                                    description="The page goes back to what it said then. The current version stays in the history."
                                    confirmLabel="Restore"
                                    confirmVariant="default"
                                    pending={restoring}
                                    onConfirm={() => void restore()}
                                >
                                    <Button size="xs">Restore this version</Button>
                                </ConfirmDialog>
                            )}
                        </div>
                    )}
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {!selected ? (
                            <p className="p-6 text-sm text-muted-foreground">No version recorded for this page yet.</p>
                        ) : preview?.id !== selected.id ? (
                            <PreviewSkeleton />
                        ) : (
                            <PageColumn>
                                <h1 className="text-[2rem] font-semibold leading-tight tracking-tight">{selected.title}</h1>
                                <BrainEditor key={selected.id} className="mt-6" content={preview.content} editable={false} titles={titles} onOpenPage={onOpenPage} onOpenFile={onOpenFile} />
                            </PageColumn>
                        )}
                    </div>
                </div>

                <aside className="flex min-h-0 shrink-0 flex-col border-border sm:w-64 sm:border-l max-sm:max-h-48 max-sm:border-b">
                    <p className="px-4 pb-1 pt-3 text-[11px] font-medium text-muted-foreground/80">Versions</p>
                    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                        {revisions.map((revision, index) => (
                            <button
                                key={revision.id}
                                type="button"
                                onClick={() => setSelectedId(revision.id)}
                                className={cn('block w-full rounded-md px-2 py-1.5 text-left transition-colors', revision.id === selectedId ? 'bg-accent' : 'hover:bg-accent/60')}
                            >
                                <span className="block text-sm font-medium" title={fullDateTime(revision.createdAt, locale)}>
                                    {index === 0 && revision.hash === page.hash ? 'Current' : shortRelativeTime(revision.createdAt, locale)}
                                </span>
                                <span className="block truncate text-xs text-muted-foreground">
                                    {brainAuthorLabel(revision.author)}
                                    {revision.proposalId ? ' · From a proposal' : ''}
                                </span>
                            </button>
                        ))}
                    </div>
                </aside>
            </div>
        </div>
    )
}
