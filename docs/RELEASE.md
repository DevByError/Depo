# Releasing Depo

How a version goes from this repository to people's PCs. The build and signing steps could not be run
from the development sandbox, so the first release is a rehearsal: do it with a pre-release tag first.

## 1. Choose the version

```
bun scripts/set-version.ts 0.2.0
bun run check
git commit -am "Release 0.2.0"
git tag v0.2.0
git push && git push --tags
```

`set-version` changes every place that carries the version (all `package.json` files, `tauri.conf.json`,
`Cargo.toml` and `DEPO_VERSION`). A test fails if they ever disagree, and the release workflow refuses a
tag that does not match `DEPO_VERSION`.

## 2. What the workflow does

`.github/workflows/release.yml` runs on a `v*` tag on a Windows machine:

1. installs everything, then runs `bun run check` (lint, types and all tests);
2. builds the engine sidecar and the MSI and NSIS installers;
3. signs them when a certificate is configured (below);
4. writes `SHA256SUMS.txt` and publishes a **draft** GitHub release. Read the notes, then publish it yourself.

## 3. Signing (recommended before sharing with anyone)

Unsigned installers work, but Windows SmartScreen shows a warning. To sign:

1. Buy a code-signing certificate (an OV or EV certificate from a certificate authority) and export it as `.pfx`.
2. In the GitHub repository, add two secrets:
   - `WINDOWS_CERTIFICATE`: the `.pfx` file as base64 (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`);
   - `WINDOWS_CERTIFICATE_PASSWORD`: its password.
3. Tag a release. The workflow imports the certificate for the build only and passes its thumbprint to Tauri.

The secrets are only handed to the steps that need them and are never echoed.

## 4. Updates

Depo never updates itself and never contacts the internet on its own. **Settings -> Updates**: enter the
repository (for example `your-name/depo`) and press **Check for updates**. If a newer release exists, the
person gets a link to the download page and installs it themselves.

Silent in-app installs (the Tauri updater plugin) need a signing key pair (`bunx tauri signer generate`),
the plugin in `Cargo.toml` and `tauri.conf.json`, and a hosted `latest.json`. They were left out on purpose:
they cannot be tested without a real signed release. Add them after the first manual release works.

## 5. Before you announce a release

- Install the MSI on a clean Windows machine (or a virtual machine) and open the app.
- Walk through the welcome tour, create a project, run one small task with a real model, approve the diff.
- Run the browser end-to-end tests (`bun run test:e2e` in `apps/desktop`; set `PW_CHROMIUM_PATH` to Edge if needed).
- Uninstall, and check that the data folder is left alone unless the person chose to delete it.
