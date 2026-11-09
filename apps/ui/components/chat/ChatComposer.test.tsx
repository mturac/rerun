// @vitest-environment happy-dom
import { act, createElement, type ReactNode, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    uploads: { byId: new Map(), enqueue: vi.fn(), cancel: vi.fn(), retry: vi.fn(), clearFinished: vi.fn(), waitForAll: vi.fn().mockResolvedValue([]) },
    toast: vi.fn(),
}))
vi.mock('@/hooks/useFileUploads', () => ({ useFileUploads: () => mocks.uploads }))
vi.mock('@/hooks/useVoiceMessage', () => ({ useVoiceMessage: () => ({ status: 'idle', start: vi.fn(), finish: vi.fn(), retry: vi.fn(), discard: vi.fn() }) }))
vi.mock('@/hooks/useComposerLinks', () => ({ useComposerLinks: () => ({ expand: (text: string) => text, collapse: (text: string) => text, refresh: () => {}, clear: () => {}, hasTokens: false, handlers: {} }) }))
vi.mock('@/components/chat/ChatAttachments', () => ({ ChatAttachments: () => null, AttachButton: () => null }))
vi.mock('@/components/chat/ComposerLinkMirror', () => ({ ComposerLinkMirror: () => null }))
vi.mock('@/components/chat/QueuedMessagePill', () => ({ QueuedMessagePill: () => null }))
vi.mock('@/components/chat/VoiceComposerControls', () => ({ VoiceComposerControls: () => null }))
vi.mock('@/components/chat/VoiceRecorderBar', () => ({ VoiceRecorderBar: () => null }))
vi.mock('@/components/ui/markdown-editor-dialog', () => ({ MarkdownEditorDialog: () => null }))
vi.mock('@/app/api/_actions/file.actions', () => ({ deleteFileAction: vi.fn() }))
vi.mock('@/app/api/_actions/foreman-file.actions', () => ({ deleteForemanFileAction: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: { children: ReactNode }) => children, motion: { button: 'button' } }))
vi.mock('@/components/ai-elements/prompt-input', () => ({
    PromptInput: ({ children, onSubmit, onSubmitError }: { children: ReactNode; onSubmit: (value: { text: string; files: [] }) => Promise<void>; onSubmitError: (error: unknown) => void }) => createElement('form', { onSubmit: (event: { preventDefault: () => void; currentTarget: HTMLFormElement }) => {
        event.preventDefault()
        const field = event.currentTarget.querySelector('textarea')!
        const text = field.value
        field.value = ''
        void onSubmit({ text, files: [] }).catch(onSubmitError)
    } }, children),
    PromptInputTextarea: ({ ref, ...props }: { ref?: Ref<HTMLTextAreaElement> }) => createElement('textarea', { ...props, ref, name: 'message' }),
    PromptInputFooter: ({ children }: { children: ReactNode }) => createElement('div', null, children),
    PromptInputSubmit: () => createElement('button', { type: 'submit' }, 'Send'),
    PromptInputButton: ({ children }: { children: ReactNode }) => createElement('button', { type: 'button' }, children),
    PromptInputDropOverlay: () => null,
    usePromptInputAttachments: () => ({ clear: () => {} }),
}))

import { ChatComposer } from './ChatComposer'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    localStorage.clear()
    localStorage.setItem('composer-draft-one', 'Keep my message')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mocks.toast.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function submit() {
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

it('keeps the text and draft when onSend refuses after another tab stops', async () => {
    const onSent = vi.fn()
    const onSend = vi.fn(() => localStorage.getItem('composer-stopped-one') !== 'true')
    await act(async () => root.render(createElement(ChatComposer, { uid: 'one', uploadTarget: { kind: 'agent', agentId: 'agent' }, status: 'ready', busy: false, onSend, onSent, voiceEnabled: false, attachmentsEnabled: false })))
    localStorage.setItem('composer-stopped-one', 'true')
    await submit()
    expect(container.querySelector('textarea')!.value).toBe('Keep my message')
    expect(localStorage.getItem('composer-draft-one')).toBe('Keep my message')
    expect(onSent).not.toHaveBeenCalled()
})

it('keeps the text when enqueue cannot save it', async () => {
    await act(async () => root.render(createElement(ChatComposer, { uid: 'one', uploadTarget: { kind: 'agent', agentId: 'agent' }, status: 'ready', busy: true, onSend: vi.fn(), voiceEnabled: false, attachmentsEnabled: false, queue: { text: null, pending: false, enqueue: () => false, onSendNow: vi.fn(), onDiscard: vi.fn() } })))
    await submit()
    expect(container.querySelector('textarea')!.value).toBe('Keep my message')
    expect(localStorage.getItem('composer-draft-one')).toBe('Keep my message')
    expect(mocks.toast).toHaveBeenCalled()
})
