import { createFileRoute } from '@tanstack/react-router'
import { UpdatesPage } from '@/features/updates/updates-page'

export const Route = createFileRoute('/updates')({ component: UpdatesPage })
