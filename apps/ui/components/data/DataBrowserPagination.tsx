'use client'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChevronFirstIcon, ChevronLastIcon, ChevronLeftIcon, ChevronRightIcon } from '@/lib/icons'
import { formatNumber } from '@rerun/i18n/format'
import { useLocale } from 'next-intl'

export const PAGE_SIZES = [25, 50, 100, 250]

type DataBrowserPaginationProps = {
    pageIndex: number
    pageSize: number
    shown: number
    total: number
    onPageSizeChange: (size: number) => void
    onPageChange: (index: number) => void
}

export function DataBrowserPagination({ pageIndex, pageSize, shown, total, onPageSizeChange, onPageChange }: DataBrowserPaginationProps) {
    const locale = useLocale()
    const canPrev = pageIndex > 0
    const canNext = pageIndex * pageSize + shown < total
    const lastPageIndex = Math.max(0, Math.ceil(total / pageSize) - 1)
    const pages = total > pageSize

    return (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/70 px-4 py-1.5 text-[11px] text-muted-foreground @3xl:px-12">
            <span>
                Count <span className="font-medium text-foreground tabular-nums">{formatNumber(total, locale)}</span>
            </span>
            <span className="flex items-center gap-1">
                <Select value={String(pageSize)} onValueChange={value => onPageSizeChange(Number(value))}>
                    <SelectTrigger size="sm" aria-label="Rows per page" className="h-6 w-auto gap-1 border-transparent bg-transparent px-1.5 text-[11px] shadow-none hover:bg-accent dark:bg-transparent">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {PAGE_SIZES.map(size => (
                            <SelectItem key={size} value={String(size)} className="text-xs">
                                {size} per page
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {pages && (
                    <>
                        <span className="px-1 whitespace-nowrap tabular-nums">
                            {pageIndex * pageSize + 1}–{pageIndex * pageSize + shown} of {formatNumber(total, locale)}
                        </span>
                        <Button variant="ghost" size="icon-xs" disabled={!canPrev} onClick={() => onPageChange(0)} aria-label="First page" className="hidden text-muted-foreground @md:inline-flex">
                            <ChevronFirstIcon className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon-xs" disabled={!canPrev} onClick={() => onPageChange(Math.max(0, pageIndex - 1))} aria-label="Previous page" className="text-muted-foreground">
                            <ChevronLeftIcon className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon-xs" disabled={!canNext} onClick={() => onPageChange(pageIndex + 1)} aria-label="Next page" className="text-muted-foreground">
                            <ChevronRightIcon className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon-xs" disabled={!canNext} onClick={() => onPageChange(lastPageIndex)} aria-label="Last page" className="hidden text-muted-foreground @md:inline-flex">
                            <ChevronLastIcon className="size-3.5" />
                        </Button>
                    </>
                )}
            </span>
        </div>
    )
}
