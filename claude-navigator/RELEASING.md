# Signed releases and automatic updates

Once this is set up, Claude Navigator is a properly signed and notarised Mac app:

- macOS stops asking for permission again after every update.
- Updates arrive by themselves. The app checks on start-up and every few hours, downloads quietly, and says "Version x is ready". It installs when you restart (or next time you quit).
- New versions are built, signed and notarised by GitHub on a Mac in the cloud, so your own Mac needs no tools.

Your source code stays private. Only the finished app goes into a separate public repository, `claude-navigator-releases`, where the app looks for updates.

## One-time setup (about an hour, plus Apple's approval wait)

Keep every password and file below private. Never paste them into a chat, including with Claude. They only ever go into GitHub's **Secrets** page (step 8).

### 1. Join the Apple Developer Program

Go to developer.apple.com/programs/enroll and enrol as an **Individual**, using your Apple ID. It costs A$149 a year. Approval usually takes a day or two and arrives by email.

### 2. Make your "Developer ID Application" certificate

1. On your Mac, open **Keychain Access**. From the menu bar choose **Keychain Access › Certificate Assistant › Request a Certificate From a Certificate Authority…**
2. Enter your email and name, choose **Saved to disk**, and save the file.
3. At developer.apple.com/account/resources/certificates, click **+**, choose **Developer ID Application**, then upload the file from step 2.
4. Download the certificate and double-click it. It is added to Keychain Access.
5. In Keychain Access, under **My Certificates**, right-click **Developer ID Application: (your name)** and choose **Export…**
6. Save it as a `.p12` file and give it a password. You need this password in step 8 as `MAC_CERT_PASSWORD`.
7. In Terminal, run this. It copies the certificate as text to your clipboard, ready for step 8:

```bash
base64 -i ~/Desktop/Certificates.p12 | pbcopy
```

(Change the path if you saved the `.p12` file somewhere else.)

### 3. Make an app-specific password, so Apple can notarise the app

At account.apple.com, go to **Sign-In and Security › App-Specific Passwords**, click **+**, and name it "Claude Navigator". Copy the password it shows; it is shown only once.

### 4. Team ID

Already done: your Team ID (484VNWY9P3) is set in the release workflow.

### 5. Create the public releases repository

On GitHub, create a new **public** repository named exactly `claude-navigator-releases` under `dupreez1979-sketch`, and tick "Add a README file". Leave it otherwise empty.

### 6. Make a token that can publish to it

On GitHub, go to **Settings › Developer settings › Personal access tokens › Fine-grained tokens › Generate new token**:

- **Repository access:** Only select repositories › `claude-navigator-releases`
- **Permissions:** Repository permissions › **Contents: Read and write**
- **Expiration:** one year. Set a reminder to renew it.

Copy the token.

### 7. Allow GitHub Actions in this repository

In `General-Internal` on GitHub, go to **Settings › Actions › General**. Make sure Actions are allowed.

### 8. Add the secrets

In `General-Internal` on GitHub, go to **Settings › Secrets and variables › Actions › New repository secret**, and add these five:

| Name | Value |
|---|---|
| `MAC_CERT_P12_BASE64` | the text copied in step 2.7 |
| `MAC_CERT_PASSWORD` | the `.p12` password from step 2.6 |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the password from step 3 |
| `RELEASES_TOKEN` | the token from step 6 |

Then delete the `.p12` file and the request file from your Desktop, and clear your clipboard.

Tell Claude when this is done. Claude will then publish the first release.

## Publishing a new version

Claude does this for you. For the record, these are the steps:

1. Raise `version` in `claude-navigator/package.json` (for example 0.2.0 to 0.2.1) and commit it.
2. Push it. GitHub notices the new version number and starts the release (a version that is already published is skipped).
3. GitHub builds, signs and notarises the app (about 15 minutes), then publishes it to `claude-navigator-releases`. You can watch it under **Actions** in `General-Internal`.
4. Every installed copy picks it up within a few hours, or straight away with **… › Check for Updates…**

## Switching from the install script to the signed app (once)

1. Open the latest release at github.com/dupreez1979-sketch/claude-navigator-releases/releases.
2. Download the `.dmg`: **arm64** for an Apple-silicon Mac (M1 or later), **x64** for an older Intel Mac. To check, choose Apple menu › About This Mac.
3. Quit Claude Navigator. Open the `.dmg` and drag the app to **Applications**, choosing **Replace**.
4. Open it. Your folders, profiles and Claude sign-in are all kept. macOS may ask once for access to Documents; allow it.

From then on it updates itself. You no longer need GitHub Desktop or **Install or Update.command** (it still works, and is handy for trying unreleased changes).
