import { toast } from 'sonner'
import type { DuplicateAgentResult } from '@/app/api/_actions/agent.actions'
import type { InstallSharedAgentResult } from '@/app/api/_actions/agent-share.actions'
import type { InstallTemplateResult } from '@/app/api/_actions/template.actions'
import { fireRerunConfetti } from '@/lib/confetti'

type Installed = Extract<InstallTemplateResult, { ok: true }>

// Both entry points (importing into an existing space, and replaying a parked template after
// checkout) report the same thing, and the only part of the copy that matters is what the user
// still has to do: the connectors arrive disconnected.
export function reportInstall(result: Installed, title: string): void {
    if (result.alreadyInstalled) {
        toast.info(`"${title}" is already on your board`, { description: 'Its coworkers are opening where you left them.' })
        return
    }
    const problems = [...result.failed.map(failure => `${failure.name} could not be imported.`), ...result.warnings]
    // Un agent posé mais éteint a l'air installé et ne fera pourtant rien : c'est la seule chose du
    // lot qui a besoin d'être dite avant les connecteurs.
    if (result.inactive > 0) problems.unshift(`${result.inactive} of them are inactive: your plan has no free coworker slot.`)
    // La pluie de logos salue les agents qui atterrissent pour de vrai, pas le drop sur le bloc
    // fantôme : en onboarding, celui-ci est suivi de la création de compte et du paiement.
    if (result.imported > 0) void fireRerunConfetti()
    toast.success(`${result.imported} coworker${result.imported === 1 ? '' : 's'} from "${title}" landed on your board`, {
        description: problems.length > 0 ? problems.join(' ') : 'Open one and start its installation: it connects what it needs with you.',
    })
}

// Le pendant d'un lien de partage : un seul agent, donc pas de compte à rendre sur un lot, mais les
// mêmes choses à dire ensuite. Les connecteurs arrivent déconnectés et le webhook a changé
// d'adresse: c'est la seule partie que le destinataire ne peut pas voir par lui-même.
export function reportShareInstall(result: Extract<InstallSharedAgentResult, { ok: true }>): void {
    const problems = [...result.warnings]
    if (result.inactive) problems.unshift('It landed inactive: your plan has no free coworker slot.')
    if (!result.inactive) void fireRerunConfetti()
    toast.success(`"${result.agentName}" landed on your board`, {
        description: problems.length > 0 ? problems.join(' ') : 'Open it and start its installation: it connects what it needs with you.',
    })
}

export function reportArchiveImport(result: { agentName: string; inactive: boolean; warnings: string[] }): void {
    const problems = [...result.warnings]
    if (result.inactive) problems.unshift('It landed inactive: your plan has no free coworker slot.')
    if (!result.inactive) void fireRerunConfetti()
    toast.success(`"${result.agentName}" landed on your board`, {
        description: problems.length > 0 ? problems.join(' ') : 'Open it and start its installation: it connects what it needs with you.',
    })
}

// Une copie n'a rien à installer : elle garde ses clés, ses connecteurs signés et le modèle sur
// lequel elle était épinglée. Ce qu'elle ne peut pas dire d'elle-même, ce sont ses deux effets de
// bord : les webhooks ont changé d'adresse, et le travail périodique se fait maintenant en double.
export function reportDuplicate(result: Extract<DuplicateAgentResult, { ok: true }>): void {
    const notes: string[] = []
    if (result.inactive) notes.push('It landed inactive: your plan has no free coworker slot.')
    if (result.triggers.length > 0) notes.push(`${result.triggers.length} webhook${result.triggers.length === 1 ? '' : 's'} got a new URL: point your services at the copy's own address.`)
    if (!result.inactive && result.schedules.length > 0) {
        notes.push(`${result.schedules.length} schedule${result.schedules.length === 1 ? ' runs' : 's run'} on the copy too. Turn ${result.schedules.length === 1 ? 'it' : 'them'} off if the work should not happen twice.`)
    }
    if (!result.inactive) void fireRerunConfetti()
    toast.success(`"${result.agentName}" landed on your board`, {
        description: notes.length > 0 ? notes.join(' ') : 'It carries everything the original had and is ready to run.',
    })
}
