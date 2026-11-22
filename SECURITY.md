# Security Policy

NexQ handles sensitive material: live meeting audio, transcripts, personal documents and API keys. We take security reports seriously and appreciate responsible disclosure.

## Supported versions

Security fixes are released for the **latest minor version** only. NexQ updates itself automatically, so most users are on it within days of a release.

| Version | Supported |
|---|---|
| Latest minor release (see [Releases](https://github.com/naxhq/NexQ/releases/latest)) | Yes |
| Any older version | No, please update |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public issues, discussions or pull requests.**

Report privately through GitHub Security Advisories:

1. Go to the [Security tab](https://github.com/naxhq/NexQ/security) of this repository.
2. Click **Report a vulnerability** ([direct link](https://github.com/naxhq/NexQ/security/advisories/new)).
3. Fill in the form.

Please include:

- The NexQ version and OS (Windows or macOS, with version)
- A description of the issue and its impact
- Steps to reproduce or a proof of concept
- Any suggested fix or mitigation

If you cannot use GitHub Security Advisories, open a public issue that says only that you would like a private contact, with no technical details, and a maintainer will reach out.

## What to expect

| Step | Target time |
|---|---|
| Acknowledgement of your report | within 3 business days |
| Initial assessment and severity | within 7 days |
| Fix for critical and high severity issues | within 30 days, where feasible |
| Fix for moderate and low severity issues | in a following release |

We will keep you informed as we work on a fix, agree on a disclosure date with you, and credit you in the advisory and release notes unless you prefer to stay anonymous. NexQ is maintained by a small team of volunteers, so please allow some flexibility on timelines.

## Scope

NexQ is a local desktop application. In scope:

- **Credential storage:** API keys and tokens leaking out of the OS credential store (Windows Credential Manager, macOS Keychain), into logs, the SQLite database, settings files, crash output or the AI Call Log.
- **Claude CLI integration:** the Claude (subscription) provider runs the locally installed `claude` CLI as a child process with tools disabled. Issues such as executing unintended commands, enabling tools, prompt injection that escapes the intended sandbox, or leaking the user's Claude session are in scope.
- **Updater:** bypassing Ed25519 signature verification, downgrade attacks or installing an unsigned update.
- **Data exposure:** transcripts, recordings, documents or meeting data being sent somewhere the user did not configure, or readable by other local users.
- **Stealth Mode:** the overlay appearing in screen captures while "Hide from screen share" reports it as hidden, where the OS API is expected to apply.
- **IPC and webview:** abusing Tauri commands, the asset protocol, or rendered Markdown and model output to read files or execute code.
- **Local privilege escalation** through the installer or the app.

Out of scope:

- Vulnerabilities in third-party services you connect (OpenAI, Deepgram, Anthropic and others); please report those to the vendor.
- Data a user deliberately sends to a cloud provider they configured.
- Attacks that require an already-compromised machine or administrator access.
- The absence of Windows code signing or macOS notarization (a known limitation, documented in the README).
- Social engineering and denial of service against GitHub infrastructure.

## Security model, in short

- API keys are stored in the OS credential store, not in plain-text files.
- Updates are downloaded from GitHub Releases and verified against the Ed25519 public key embedded in the app before installation.
- NexQ has no telemetry. Network traffic goes only to providers you configure and to GitHub Releases for update checks.
- The webview runs without a Content Security Policy by design (local-only app), so any path that renders untrusted content as HTML is security-relevant.

## Verify a download

Releases are signed with minisign. Each installer on the [releases page](https://github.com/naxhq/NexQ/releases) has a matching `.sig` file, and the app checks that signature before it installs an update. To check a download yourself, the public key is:

```
untrusted comment: minisign public key: 333EFC94A407E29A
RWSa4geklPw+Mw1zySvTddemXH0UFe2fq9ds6KpXfEylBTf9GbrrivlR
```

Key ID `333EFC94A407E29A`. This is the same key as `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, which holds these two lines base64-encoded.

1. Download the installer and its `.sig` file.
2. The `.sig` is a base64 encoding of a minisign signature, so decode it first. On Windows: `certutil -decode NexQ_<version>_x64-setup.exe.sig NexQ_<version>_x64-setup.exe.minisig`. On macOS or Linux: `base64 -d NexQ_<version>_x64-setup.exe.sig > NexQ_<version>_x64-setup.exe.minisig`.
3. Verify it with [minisign](https://jedisct1.github.io/minisign/): `minisign -Vm NexQ_<version>_x64-setup.exe -x NexQ_<version>_x64-setup.exe.minisig -P RWSa4geklPw+Mw1zySvTddemXH0UFe2fq9ds6KpXfEylBTf9GbrrivlR`

Use the real file names from the release. A good check prints "Signature and comment signature verified".

The Windows installer is not Authenticode signed, so PowerShell's `Get-AuthenticodeSignature` reports `NotSigned` and SmartScreen may warn on first run. That is expected; the minisign check is how you confirm the file is ours.
