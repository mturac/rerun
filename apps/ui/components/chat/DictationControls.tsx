'use client'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Spinner } from '@/components/ui/spinner'
import type { DictationStatus } from '@/hooks/useDictation'
import { CheckIcon, MicIcon, XIcon } from '@/lib/icons'

type DictationControlsProps = {
    status: DictationStatus
    onStart: () => void
    onFinish: () => void
    onCancel: () => void
}

/**
 * The composer's dictation controls: a microphone that toggles into recording, then the
 * discard / transcribe pair while words are being captured. Escape discards too.
 */
export function DictationControls({ status, onStart, onFinish, onCancel }: DictationControlsProps) {
    if (status === 'idle') {
        return (
            <PromptInputButton variant="ghost" tooltip="Dictate into the composer" aria-label="Dictate into the composer" onClick={onStart}>
                <MicIcon className="size-4" />
            </PromptInputButton>
        )
    }

    const busy = status === 'starting' || status === 'transcribing'

    return (
        <>
            <PromptInputButton tooltip="Discard dictation" aria-label="Discard dictation" onClick={onCancel} disabled={status === 'transcribing'}>
                <XIcon className="size-4" />
            </PromptInputButton>
            <PromptInputButton
                variant="default"
                tooltip={status === 'transcribing' ? 'Transcribing' : 'Transcribe'}
                aria-label={status === 'transcribing' ? 'Transcribing dictation' : 'Transcribe dictation'}
                onClick={onFinish}
                disabled={busy}
            >
                {status === 'transcribing' ? <Spinner /> : <CheckIcon className="size-4" />}
            </PromptInputButton>
        </>
    )
}
