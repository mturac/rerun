'use client'

import { useRef, useState } from 'react'

import { importAgentArchiveAction } from '@/app/api/_actions/agent-import.actions'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useManageableSpaceIds } from '@/hooks/useBoxAccess'
import { UNNAMED_BOX_LABEL } from '@/lib/board/types'
import { reportArchiveImport } from '@/lib/templates/install-feedback'
import { useBoardStore } from '@/stores/board.store'

const ARCHIVE_ACCEPT = '.tar.gz,.tgz,application/gzip,application/x-gzip'
const AGENT_NAME_MAX = 60

export function ImportAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const spaces = useBoardStore(s => s.spaces)
    const manageableIds = useManageableSpaceIds()
    const destinations = spaces.filter(space => manageableIds.has(space.id)).sort((a, b) => (a.name || UNNAMED_BOX_LABEL).localeCompare(b.name || UNNAMED_BOX_LABEL))

    const fileInputRef = useRef<HTMLInputElement>(null)
    const [archive, setArchive] = useState<File | null>(null)
    const [name, setName] = useState('')
    const [spaceId, setSpaceId] = useState<string | null>(null)
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const targetSpaceId = spaceId ?? destinations[0]?.id ?? null
    const canSubmit = !!archive && !!name.trim() && !!targetSpaceId && !pending

    const reset = () => {
        setArchive(null)
        setName('')
        setSpaceId(null)
        setError(null)
    }

    const close = (next: boolean) => {
        if (!next) reset()
        onOpenChange(next)
    }

    const submit = async () => {
        if (!canSubmit || !targetSpaceId) return
        setPending(true)
        setError(null)
        const formData = new FormData()
        formData.set('archive', archive)
        formData.set('name', name.trim())
        formData.set('spaceId', targetSpaceId)
        const result = await importAgentArchiveAction(formData)
        setPending(false)
        if (!result.ok) {
            setError(result.error)
            return
        }
        reportArchiveImport(result)
        useBoardStore.getState().selectAgentWhenReady(result.agentId)
        close(false)
    }

    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Import coworker</DialogTitle>
                    <DialogDescription>A captured coworker folder (.tar.gz), such as an archive exported from another Rerun or a converted Grok Bot package. Its keys and connected apps do not travel: it asks for what it still needs.</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <Field label="Archive" helperText="The .tar.gz file to import.">
                        <div className="flex items-center gap-2">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept={ARCHIVE_ACCEPT}
                                className="hidden"
                                onChange={event => {
                                    setArchive(event.target.files?.[0] ?? null)
                                    setError(null)
                                    event.target.value = ''
                                }}
                            />
                            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={pending}>
                                Choose file
                            </Button>
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{archive ? archive.name : 'No file chosen'}</span>
                        </div>
                    </Field>

                    <Input label="Name" required maxLength={AGENT_NAME_MAX} placeholder="Display name on the board" value={name} onChange={event => setName(event.target.value)} disabled={pending} />

                    <Field label="Box" htmlFor="import-agent-space">
                        <Select value={targetSpaceId ?? undefined} onValueChange={setSpaceId} disabled={pending || destinations.length === 0}>
                            <SelectTrigger id="import-agent-space" className="w-full">
                                <SelectValue placeholder={destinations.length === 0 ? 'No Box you can manage' : 'Pick a Box'} />
                            </SelectTrigger>
                            <SelectContent position="popper">
                                {destinations.map(space => (
                                    <SelectItem key={space.id} value={space.id}>
                                        {space.name || UNNAMED_BOX_LABEL}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>

                    {error && <p className="text-xs text-destructive">{error}</p>}
                </div>

                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => close(false)} disabled={pending}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={() => void submit()} loading={pending} disabled={!canSubmit}>
                        Import
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
