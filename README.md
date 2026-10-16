# Nabta POS — نبتة

نبتة هو تطبيق نقاط بيع عربي لأجهزة Windows، مخصص للمبيعات والمخزون والعمل المحلي. يتضمن مشروع المصدر واجهة Electron، وخادمًا محليًا مضمّنًا، ودعم أجهزة نقاط البيع مثل قارئ الباركود والطابعات.

## Download / التنزيل

- [Windows releases / إصدارات ويندوز](https://github.com/nopoh28102/Nabta-POS/releases)
- [Source code / كود المصدر](https://github.com/nopoh28102/Nabta-POS)
- [MIT license](LICENSE)

يُوزَّع البرنامج كملف تثبيت NSIS بصيغة EXE. التحديثات تُفحص عبر GitHub Releases، لكن التنزيل والتثبيت يحتاجان موافقة المستخدم.

## Code signing policy / سياسة التوقيع الرقمي

See the [Code signing policy](CODE_SIGNING_POLICY.md), [privacy notice](PRIVACY.md), and [SignPath setup instructions](docs/SIGNPATH_SETUP.md).

**Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/)**, subject to approval and activation. Before that approval, releases are not guaranteed to be digitally signed. A trusted signature does not guarantee that SmartScreen will never display a warning.

## Developers

The desktop package is at [apps/desktop](apps/desktop), with Windows packaging through electron-builder and GitHub Actions. See [SignPath setup](docs/SIGNPATH_SETUP.md) for the two-stage signing workflow and release verification.
