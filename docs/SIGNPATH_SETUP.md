# SignPath Foundation — Nabta POS Windows release setup

This document describes a **proposed** free OSS code-signing pipeline. Nothing here constitutes an accepted SignPath Foundation subscription. Keep the pull request in **draft** until approval, setup, and a full updater smoke test.

## 1. Check eligibility and apply

- Apply at https://signpath.org/apply.html and read https://signpath.org/terms.html . Approval depends on repository reputation, maintenance, release history, and review of project source; a license alone is not enough.
- Nabta POS uses an MIT root LICENSE and has a Windows release, but **audit all bundled binaries**, especially \`apps/desktop/build/drivers\`, Electron, PGlite, native serial-port modules, and installer resources. SignPath forbids signing upstream/third-party binaries as if they were our own and imposes restrictions on proprietary components.
- Maintain the linked homepage/README, privacy disclosure and **Code signing policy**, and include a link to the policy on download/release pages.
- Enable multi-factor authentication, assign trusted release approvers, review non-maintainer PRs, protect the release pipeline and tags, and satisfy SignPath's manual-per-release approval rule.
- SignPath Foundation is the *certificate publisher*. The certificate is not issued to a new legal entity named Nabta POS. No arrangement can guarantee immediate SmartScreen acceptance.

## 2. Configure SignPath after acceptance

1. In SignPath, create/link a project corresponding to this public repo and the trusted **GitHub.com** build system. Install/authorize the SignPath GitHub App as requested.
2. Create a release signing policy with designated **manual approver(s)**; do not configure automatic release approval for the Foundation subscription.
3. Create two artifact configurations using \`signpath/artifact-app.xml\` and \`signpath/artifact-installer.xml\`. Suggested slugs: \`nabta-app-exe\` and \`nabta-installer-exe\`. Both accept GitHub Actions ZIP artifacts.
4. **Verify file metadata against real unsigned sample files.** Adjust \`product-name\`/\`product-version\`/\`file-version\` to match Windows VERSIONINFO; include all SignPath-required metadata restrictions before activating. Installer and app metadata can differ. The XML files in this PR are templates, **not approved configurations**.
5. Give a narrowly scoped SignPath API token permission to submit requests under the project and policy. Store it only in repository Actions secrets.

In GitHub repository **Settings → Secrets and variables → Actions**, configure:

| Type | Name | What it means |
| --- | --- | --- |
| Secret | \`SIGNPATH_API_TOKEN\` | API token with signing-request submitter rights |
| Variable | \`SIGNPATH_ORGANIZATION_ID\` | organization ID |
| Variable | \`SIGNPATH_PROJECT_SLUG\` | project slug |
| Variable | \`SIGNPATH_SIGNING_POLICY_SLUG\` | manual release signing policy slug |
| Variable | \`SIGNPATH_APP_ARTIFACT_CONFIGURATION_SLUG\` | application-EXE artifact configuration slug |
| Variable | \`SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG\` | NSIS-installer artifact configuration slug |

Never put tokens or certificates in git, PR descriptions, artifacts, or logs.

## 3. Release workflow

The workflow \`.github/workflows/release.yml\` runs for tags matching \`v*\`, on a GitHub-hosted Windows runner:

1. Verify the tag matches \`apps/desktop/package.json\` version; typecheck and build the app and local server.
2. Package \`win-unpacked\` only. Set updater certificate publisher to **SignPath Foundation** in \`app-update.yml\` (required since signing happens outside electron-builder).
3. Upload the **application EXE** as a GitHub Actions ZIP artifact, request SignPath approval/signature, then restore and verify the signed EXE.
4. Repack NSIS with \`--prepackaged\` and \`nsis.differentialPackage=false\`; do not change \`appId\`, target, app data location, or the GitHub update provider.
5. Upload the **unsigned NSIS installer** as a second workflow artifact, get its SignPath signature, and verify the signed EXE.
6. Recompute SHA-512 and size for the **final signed** installer in \`latest.yml\` (the old metadata hashes the unsigned file). Fail closed if differential metadata is present or the expected installer filename/version differs.
7. Only after signature and metadata verification, publish the signed installer **and final latest.yml together** via GitHub Releases. No public unsigned release is published by the release workflow.

**Trade-off:** differential downloads are disabled for this SignPath path to avoid invalid embedded blockmaps when signing after NSIS is built. Full-file auto-update and user confirmation remain. Do not re-enable differential updates until signing and the blockmap placement have been tested together.

## 4. Manual acceptance tests before merging

- A GitHub Actions run cannot be completed until SignPath accepts the repo, grants access, and approves both signing requests.
- Run unsigned test packaging first, inspect the emitted EXE name and Windows VERSIONINFO; align the two XML files and configuration slugs.
- On a Windows machine, verify both main application executable and NSIS installer display **Valid** Authenticode signatures, subject SignPath Foundation.
- Verify \`latest.yml\` uses the final signed EXE's SHA-512 (base64) and byte size and points to the exact released filename.
- Install a previous public unsigned version on a **test PC**, update it via GitHub Releases to the signed test version, and verify data retention, printing, local server start, and app restarts. Then test signed-to-signed update to confirm publisher verification.
- Do not replace an existing published tag/assets for updater testing. Test against a new **higher** version/tag; tag version must match the package version.
- Confirm current \`apps/desktop/package.json\` uses Electron Builder v26 before adapting the scripts to other builder versions.

## References

- SignPath Foundation: https://signpath.org/terms.html
- SignPath GitHub workflow: https://docs.signpath.io/trusted-build-systems/github
- SignPath artifact configuration: https://docs.signpath.io/artifact-configuration/syntax
- electron-builder v26 CLI: https://www.electron.build/v26/docs/cli/
- electron-builder v26 NSIS options: https://www.electron.build/v26/docs/nsis/
