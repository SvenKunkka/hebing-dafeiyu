# Third-party software notices

DSH Forge is an independent client built on DeepSeek Harness and the third-party DeepSeekBot project. It is not an official DeepSeek or Grok product. Its interface takes inspiration from persistent robot workflows without copying Grok Bot application code or cloud data.

The desktop distribution contains:

- DeepSeek Harness (`@deepseek-ai/dsh`) 0.2.1-rc.3 and its production dependencies — [official repository](https://github.com/deepseek-ai/deepseek-harness), package-declared MIT license.
- DeepSeekBot 1.4.1 and BotHarness components — [project repository](https://github.com/BotHarness/DeepSeekBot), package-declared MIT license.
- Electron 45.3.3 — [Electron repository](https://github.com/electron/electron), MIT license; Chromium and bundled software retain their own license notices.
- Node.js 26.8.1, official darwin-arm64 distribution — [Node.js](https://nodejs.org/), MIT and included third-party licenses.

Packaging generates `third-party-licenses/manifest.json` and copies the license, copyright and notice files shipped by each installed production dependency. The Electron and Chromium notices and the complete Node.js LICENSE file are included there as well. The application license does not replace those dependency licenses. The generated directory is available inside the application at `Contents/Resources/app/third-party-licenses`.

Binary dependency packages can place their notices in `licenses/`, `sources/`, README files, and component-version manifests rather than a top-level LICENSE. Those available notices are preserved too. In particular, the unchanged sharp-libvips dynamic libraries retain the upstream library license table and exact component versions, the LGPLv3/GPLv3 texts, and links to the matching build recipe and libvips source release. LibreOffice Kit retains its distributed engine notices and source/build information. These files record upstream declarations and available source information; they do not convert third-party components to the DSH Forge MIT license.

The optional `@tencent-connect/qqbot-connector` package declares `UNLICENSED` without a redistribution notice. It is excluded from this desktop payload. QQ/IM integration is disabled and is not included in this client build. Development installations can still resolve the original DeepSeekBot dependency tree; the release recipe removes this connector only in its isolated staging directory, and fails for other missing or UNLICENSED production declarations until reviewed.

Build tools and development dependencies are used to prepare the application and are not installed as application-only dependencies. A tool can remain in the distribution when it is independently required by a production dependency.
