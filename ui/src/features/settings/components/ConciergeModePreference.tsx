import { SettingsRow } from "@/components/AppShell"
import { Switch } from "@/components/ui/switch"
import { useOptions, usePatchProfile, useProfile } from "@/lib/profile"

export function ConciergeModePreference() {
  const profile = useProfile()
  const options = useOptions()
  const save = usePatchProfile()
  const defaults = options.data
  const disabled = !profile.isSuccess || !defaults

  return (
    <>
      <SettingsRow
        label="Concierge mode"
        htmlFor="concierge-mode"
        description="Your whole Slack DM with Open SWE becomes one private thread it always answers in, instead of a new thread for every message."
        control={
          <Switch
            id="concierge-mode"
            checked={profile.data?.concierge_mode ?? false}
            disabled={disabled}
            onCheckedChange={(value) => {
              if (!defaults) return
              save.patch(
                { concierge_mode: value },
                defaults.default_agent_model,
                defaults.default_agent_reasoning_effort
              )
            }}
          />
        }
      />
      {(profile.error || options.error) && (
        <p role="alert" className="px-4 py-2 text-xs text-destructive">
          Could not load the concierge mode preference. Please try again.
        </p>
      )}
    </>
  )
}
