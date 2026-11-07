import { createFileRoute } from '@tanstack/react-router'
import { DeploymentsPage } from '@/features/deployments/deployments-page'

export const Route = createFileRoute('/deployments')({ component: DeploymentsPage })
