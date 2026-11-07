/**
 * Environment for commands the owner runs in the Terminal and for diagnostics tools: nothing
 * phones home (telemetry, update checks, analytics) and no browser window opens by itself.
 * Added on top of `commandEnv` (no colours, CI=1, Depo's secrets removed).
 */
export const QUIET_ENV: Record<string, string> = {
  BROWSER: "none",
  DO_NOT_TRACK: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  NUXT_TELEMETRY_DISABLED: "1",
  GATSBY_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  STORYBOOK_DISABLE_TELEMETRY: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  YARN_ENABLE_TELEMETRY: "0",
  NG_CLI_ANALYTICS: "false",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
  POWERSHELL_TELEMETRY_OPTOUT: "1",
  AZURE_CORE_COLLECT_TELEMETRY: "0",
  HOMEBREW_NO_ANALYTICS: "1",
  VCPKG_DISABLE_METRICS: "1",
  CHECKPOINT_DISABLE: "1",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NO_UPDATE_NOTIFIER: "1",
  PIP_NO_INPUT: "1",
};
