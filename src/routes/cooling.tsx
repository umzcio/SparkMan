import { createFileRoute } from '@tanstack/react-router'
import { CoolingPage } from '@/features/cooling/cooling-page'

export const Route = createFileRoute('/cooling')({ component: CoolingPage })
