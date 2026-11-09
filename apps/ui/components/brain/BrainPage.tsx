'use client'

import { BrainEditor, type BrainEditorHandle } from '@/components/brain/editor/BrainEditor'
import { PageColumn, PageProperty, PageTitle, PageTypeIcon, PageTypeSelect, UnconfirmedSections } from '@/components/brain/BrainPageParts'
import { BrainTopBar } from '@/components/brain/BrainTopBar'
import type { SharedFileRef } from '@/components/brain/useSharedFilesTree'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { confirmBrainSectionsAction } from '@/app/api/_actions/brain.actions'
import { useBrainAutosave, type AutosaveStatus } from '@/hooks/useBrainAutosave'
import { brainAuthorLabel, brainSourceLabels, isCardType } from '@/lib/brain/labels'
import { BRAIN_PAGE_ICONS } from '@/lib/brain/page-icons'
import type { BrainPageDetail } from '@/lib/engine/client'
import { ChevronRightIcon, CopyIcon, EllipsisIcon, HistoryIcon, Trash2Icon } from '@/lib/icons'
import { shortRelativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { BrainPage as BrainPageData, BrainPageSummary, BrainPageType, BrainProposal } from '@rerun/contracts'
import { Badge } from '@rerun/ui/primitives'
import { useLocale } from 'next-intl'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

type BrainPageProps = {
    detail: BrainPageDetail
    pages: BrainPageSummary[]
    titles: Map<string, string>
    files: SharedFileRef[]
    proposal: BrainProposal | null
    onOpenPage: (slug: string) => void
    onOpenFile: (path: string) => void
    onReviewProposals: () => void
    onSaved: (detail: BrainPageDetail) => void
    onHistory: () => void
    onDelete: () => Promise<void>
}

function saveLabel(status: AutosaveStatus, page: BrainPageData, locale: string): string | null {
    if (status === 'pending' || status === 'saving') return 'Saving…'
    if (status === 'saved') return 'Saved'
    if (status === 'error') return 'Not saved'
    if (status === 'conflict') return null
    return page.updatedAt ? `Edited ${shortRelativeTime(page.updatedAt, locale)}` : null
}

function Backlinks({ links, onOpenPage }: { links: BrainPageData['backlinks']; onOpenPage: (slug: string) => void }) {
    const [open, setOpen] = useState(false)
    if (links.length === 0) return null
    return (
        <div className="mt-12 border-t border-border pt-4">
            <button type="button" onClick={() => setOpen(value => !value)} className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground" aria-expanded={open}>
                <ChevronRightIcon className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} />
                {links.length} {links.length === 1 ? 'page links here' : 'pages link here'}
            </button>
            {open && (
                <div className="mt-2 space-y-0.5">
                    {links.map(link => (
                        <button key={link.slug} type="button" onClick={() => onOpenPage(link.slug)} className="block w-full rounded-md px-2 py-1 text-left text-sm underline decoration-foreground/30 underline-offset-2 transition-colors hover:bg-accent hover:decoration-foreground">
                            {link.title}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

// A brain page is its own editor: the title, the type and the body are typed in place and saved as
// they change, the way Notion does it.
export function BrainPage({ detail, pages, titles, files, proposal, onOpenPage, onOpenFile, onReviewProposals, onSaved, onHistory, onDelete }: BrainPageProps) {
    const locale = useLocale()
    const page = detail.page
    const autosave = useBrainAutosave({ page, onSaved })
    const [title, setTitle] = useState(page.title)
    const [type, setType] = useState<BrainPageType>(page.type)
    const [content, setContent] = useState(page.content)
    const [editorKey, setEditorKey] = useState(0)
    const [confirmingDelete, setConfirmingDelete] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const editorHandle = useRef<BrainEditorHandle>(null)

    const loadTheirs = async () => {
        const latest = await autosave.loadTheirs()
        if (!latest) return
        setTitle(latest.title)
        setType(latest.type)
        setContent(latest.content)
        setEditorKey(key => key + 1)
    }

    const remove = async () => {
        setDeleting(true)
        await onDelete()
        setDeleting(false)
        setConfirmingDelete(false)
    }

    const confirm = async () => {
        setConfirming(true)
        const result = await confirmBrainSectionsAction(page.slug, null)
        setConfirming(false)
        if (result.ok) onSaved(result.detail)
        else toast.error(result.error)
    }

    const section = isCardType(type) ? 'Company' : 'Pages'
    const status = saveLabel(autosave.status, page, locale)

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={[{ label: section }, { label: title.trim() || 'Untitled', icon: BRAIN_PAGE_ICONS[type] }]} status={status && <span className={cn(autosave.status === 'error' && 'text-destructive')} title={autosave.error ?? undefined}>{status}</span>}>
                <Button size="icon-sm" variant="ghost" onClick={onHistory} aria-label="Version history" title="Version history">
                    <HistoryIcon />
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label="More" title="More">
                            <EllipsisIcon />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem
                            onSelect={() => {
                                void navigator.clipboard.writeText(`[[${page.slug}]]`)
                                toast.success('Link copied', { description: `Paste [[${page.slug}]] in another page.` })
                            }}
                        >
                            <CopyIcon /> Copy link
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={onHistory}>
                            <HistoryIcon /> Version history
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
                            <Trash2Icon /> Delete
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </BrainTopBar>

            {autosave.status === 'conflict' && (
                <div className="flex flex-wrap items-center gap-2 border-y border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                        <span className="font-medium">{autosave.conflictWith ? brainAuthorLabel(autosave.conflictWith.updatedBy) : 'Someone'}</span> changed this page while you were editing.
                    </span>
                    <Button size="xs" variant="outline" onClick={loadTheirs}>
                        Load their version
                    </Button>
                    <Button size="xs" onClick={() => void autosave.keepMine()}>
                        Keep mine
                    </Button>
                </div>
            )}

            {proposal && autosave.status !== 'conflict' && (
                <div className="flex items-center gap-2 border-y border-border bg-muted/40 px-4 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{proposal.agentName}</span> <span className="text-muted-foreground">proposes a change to this page</span>
                    </span>
                    <Button size="xs" variant="outline" onClick={onReviewProposals}>
                        Review
                    </Button>
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
                <PageColumn>
                    <PageTypeIcon type={type} />
                    <PageTitle
                        value={title}
                        onChange={next => {
                            setTitle(next)
                            autosave.edit({ title: next })
                        }}
                        onEnter={() => editorHandle.current?.focus('start')}
                    />
                    {!title.trim() && <p className="mt-1 text-xs text-muted-foreground">A page needs a title to be saved.</p>}

                    <div className="mt-4 space-y-0.5 border-b border-border pb-4">
                        <PageProperty label="Type">
                            <PageTypeSelect
                                value={type}
                                onChange={next => {
                                    setType(next)
                                    autosave.edit({ type: next })
                                }}
                            />
                        </PageProperty>
                        {page.sources.length > 0 && (
                            <PageProperty label="Sources">
                                {brainSourceLabels(page.sources).map(source => (
                                    <Badge key={source} size="xs" tone="neutral" glow={false} fill="outline">
                                        {source}
                                    </Badge>
                                ))}
                            </PageProperty>
                        )}
                        {page.unconfirmed.length > 0 && <UnconfirmedSections headings={page.unconfirmed} confirming={confirming} onConfirm={() => void confirm()} />}
                        {page.updatedAt && (
                            <PageProperty label="Last edited">
                                <span className="text-foreground/80">
                                    {shortRelativeTime(page.updatedAt, locale)} by {brainAuthorLabel(page.updatedBy)}
                                </span>
                            </PageProperty>
                        )}
                    </div>

                    <BrainEditor
                        key={editorKey}
                        className="mt-6"
                        content={content}
                        pages={pages}
                        titles={titles}
                        files={files}
                        currentSlug={page.slug}
                        handleRef={editorHandle}
                        onOpenPage={onOpenPage}
                        onOpenFile={onOpenFile}
                        onChange={markdown => autosave.edit({ content: markdown })}
                        onBlur={() => void autosave.flush()}
                    />

                    <Backlinks links={page.backlinks} onOpenPage={onOpenPage} />
                </PageColumn>
            </div>

            <ConfirmDialog
                open={confirmingDelete}
                onOpenChange={setConfirmingDelete}
                pending={deleting}
                title={`Delete "${page.title}"?`}
                description="Coworkers stop reading it and other pages linking to it lose the link."
                onConfirm={() => void remove()}
            />
        </div>
    )
}
