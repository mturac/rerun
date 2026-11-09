'use client'

import { pickRecordingFormat } from '@/lib/voice/recording'
import { transcribeDictation } from '@/lib/voice/client'
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder'
import { useCallback, useEffect, useRef, useState } from 'react'

// Dictation is a composer aid, not a message: half a minute is already a long aside, and the
// engine route accepts far more but nobody dictates for minutes into a chat box.
export const DICTATION_MAX_MS = 30_000

export type DictationStatus = 'idle' | 'starting' | 'recording' | 'transcribing'

type Options = {
    /** The engine agent the transcription runs on. Undefined hides dictation entirely. */
    agentId?: string
    onTranscript: (text: string) => void
    onError: (message: string) => void
}

function dictationSupported(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        typeof MediaRecorder !== 'undefined' &&
        !!navigator.mediaDevices?.getUserMedia &&
        pickRecordingFormat() !== null
    )
}

/**
 * The composer's dictation: record a short aside, transcribe it on the engine's whisper.cpp and
 * hand the text back to be inserted into the draft. Escape cancels a recording; the 30 s cap
 * finishes it as if the user had.
 */
export function useDictation({ agentId, onTranscript, onError }: Options) {
    const [supported, setSupported] = useState(false)
    const [processing, setProcessing] = useState(false)

    const onTranscriptRef = useRef(onTranscript)
    const onErrorRef = useRef(onError)
    useEffect(() => {
        onTranscriptRef.current = onTranscript
        onErrorRef.current = onError
    })

    // Support is only knowable in the browser; detecting it in an effect keeps the server render
    // and the first client render identical (no mic button flashes in and out).
    useEffect(() => {
        setSupported(!!agentId && dictationSupported())
    }, [agentId])

    // Bumped by cancel and by every finish, so a transcription that lands after its recording was
    // discarded does not insert text the user already walked away from.
    const runRef = useRef(0)

    const finishRef = useRef<() => void>(() => {})
    const recorder = useVoiceRecorder({
        maxMs: DICTATION_MAX_MS,
        onError: message => onErrorRef.current(message),
        onLimitReached: () => finishRef.current(),
    })

    const { stop, cancel: cancelRecording } = recorder

    const finish = useCallback(async () => {
        if (!agentId || processing) return
        const run = ++runRef.current
        setProcessing(true)
        const recording = await stop()
        if (run !== runRef.current) return
        if (!recording) {
            setProcessing(false)
            onErrorRef.current('Nothing was recorded.')
            return
        }
        try {
            const text = await transcribeDictation(agentId, recording.blob, recording.format.extension)
            if (run !== runRef.current) return
            if (!text) onErrorRef.current("Couldn't hear anything in that recording.")
            else onTranscriptRef.current(text)
        } catch (err) {
            if (run === runRef.current) onErrorRef.current(err instanceof Error ? err.message : 'Could not transcribe your dictation.')
        } finally {
            if (run === runRef.current) setProcessing(false)
        }
    }, [agentId, processing, stop])

    const cancel = useCallback(() => {
        runRef.current++
        setProcessing(false)
        cancelRecording()
    }, [cancelRecording])

    // Escape throws the recording away, the same gesture every recorder answers to.
    const active = recorder.status !== 'idle' || processing
    useEffect(() => {
        if (!active) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') cancel()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [active, cancel])

    useEffect(() => {
        finishRef.current = () => void finish()
    })

    const start = useCallback(() => {
        if (!agentId || !supported || active) return
        runRef.current++
        void recorder.start()
    }, [agentId, supported, active, recorder])

    const status: DictationStatus = processing ? 'transcribing' : recorder.status

    return { status, supported, stream: recorder.stream, getLiveState: recorder.getLiveState, start, finish, cancel }
}
