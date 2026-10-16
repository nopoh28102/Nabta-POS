# Code signing policy / سياسة التوقيع الرقمي

**Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).** This is a requested/conditional arrangement until SignPath Foundation formally accepts the project. The signing certificate identifies **SignPath Foundation** as the publisher, not "Nabta POS".

- **Project and source:** [nopoh28102/Nabta-POS](https://github.com/nopoh28102/Nabta-POS).
- **Authors / Committers:** maintainers with GitHub write access to this repository, currently managed by [nopoh28102](https://github.com/nopoh28102).
- **Reviewers:** repository maintainer(s) with review rights. Changes from outside contributors are reviewed by a maintainer before merging.
- **Approvers:** trusted repository owner [nopoh28102](https://github.com/nopoh28102) or formally designated project release approvers. Each signing request requires an authorized, **manual** SignPath approval.
- **Security:** all maintainers and signing approvers should use multi-factor authentication for GitHub and SignPath. Protect tags, release workflow, and build scripts with appropriate review and repository rules.
- **Build origin:** releases originate from a public GitHub repository and GitHub-hosted Actions runners. The signing request uses a GitHub workflow artifact and SignPath provenance verification.
- **What is signed:** Nabta POS's own Windows application launcher and NSIS installer. Upstream/third-party executable binaries are not presented as Nabta-owned binaries for signing.
- **Metadata:** SignPath artifact policies must enforce consistent product name and version for the files signed in each release. Validate the exact Windows VERSIONINFO fields against a sample before activating the signing policy.
- **Distribution:** [GitHub Releases](https://github.com/nopoh28102/Nabta-POS/releases). Release descriptions should link to this policy.
- **Privacy:** read our [Privacy notice](PRIVACY.md). The installed app checks GitHub Releases for available updates; downloading and installation are opt-in. Operational/business data is intended to remain in the local application/server; verify any optional third-party integrations before claiming that none exist.

**Requirements before activation:** review the complete source and bundled drivers/resources for SignPath Foundation's approved-OSS-only conditions, verify no proprietary components are shipped contrary to the policy, finish documentation and privacy review, enable 2FA, and obtain SignPath Foundation acceptance. Signed artifacts and updater metadata must be verified before public release.

The signing service and certificate are free for eligible projects, but acceptance is discretionary. A signature does not guarantee suppression of all Microsoft Defender SmartScreen alerts.
