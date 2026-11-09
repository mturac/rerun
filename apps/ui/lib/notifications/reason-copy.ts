import type { EmailTranslator } from '@rerun/emails/i18n'
import type { NotificationReason } from './routing'

// The line under an inbox row, and the subtitle of an email: why this reached you.
export function reasonSentence(reason: NotificationReason, agentName: string): string {
    switch (reason) {
        case 'mine':
            return 'You started this run'
        case 'participant':
            return 'You are in this conversation'
        case 'followed':
            return `You follow ${agentName}'s scheduled tasks`
        case 'all_activity':
            return `You get all activity from ${agentName}`
        case 'everything':
            return 'You get every run in the workspace'
        case 'workspace':
            return 'This is about your workspace'
    }
}

// The same sentence in the email's language, closed by a full stop. The translator is handed in so
// the inbox, which renders the English one above in the browser, never bundles the email packs.
export function emailReasonSentence(reason: NotificationReason, agentName: string, t: EmailTranslator): string {
    switch (reason) {
        case 'mine':
            return t('reasons.mine')
        case 'participant':
            return t('reasons.participant')
        case 'followed':
            return t('reasons.followed', { agentName })
        case 'all_activity':
            return t('reasons.allActivity', { agentName })
        case 'everything':
            return t('reasons.everything')
        case 'workspace':
            return t('reasons.workspace')
    }
}
