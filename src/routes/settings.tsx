import { createFileRoute } from '@tanstack/react-router'
import { SETTINGS_SECTIONS, SettingsPage, type SettingsSection } from '@/features/settings/settings-page'

export const Route = createFileRoute('/settings')({
  validateSearch: (s: Record<string, unknown>): { section?: SettingsSection } => ({
    section: SETTINGS_SECTIONS.some((x) => x.id === s.section) && s.section !== 'appearance' ? (s.section as SettingsSection) : undefined,
  }),
  component: SettingsRoute,
})

function SettingsRoute() {
  const { section = 'appearance' } = Route.useSearch()
  const navigate = Route.useNavigate()
  return <SettingsPage section={section} onSection={(s) => void navigate({ replace: true, search: { section: s === 'appearance' ? undefined : s } })} />
}
