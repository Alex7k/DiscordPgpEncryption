# PgpEncrypt

A Vencord userplugin for seamlessly sending and receiving PGP-encrypted Discord DMs.

With plugin:

![Screenshot of a DM with the plugin](img/with_plugin.png)

Without plugin (not decrypted):

![Screenshot of a DM with the plugin](img/without_plugin.png)

## Features

- PGP-Encrypted messages
- PGP-Signed messages
- Per-DM toggle
- Encrypted attachments
- Long message splitting
- Large file splitting - large files are split into multiple files to circumvent file size limits. it's reassembled automatically on clients.
- Key management
- Key sharing and trust - share your public key by right clicking the lock icon
- Gif picker gifs sent as encrypted files (source link is attached, so there is still be a button to favorite the gif.)
-

## Quick install/update (Windows)

`install.ps1` automatically installs and injects Vencord with this plugin. Re-run any time to update. From any PowerShell window:

```powershell
irm https://raw.githubusercontent.com/Alex7k/DiscordPgpEncryption/main/install.ps1 | iex
```

After running this, start discord and enable the `PgpEncrypt` plugin in Vencord settings.

## Prerequisites

You need Git, Node.js 22 or newer, and pnpm. Pick the command block for your OS:

Windows PowerShell:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
corepack enable
corepack prepare pnpm@11.9.0 --activate
```

macOS with Homebrew:

```sh
brew install git node
corepack enable
corepack prepare pnpm@11.9.0 --activate
```

Debian/Ubuntu:

```sh
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
corepack enable
corepack prepare pnpm@11.9.0 --activate
```

(Check that everything is available):

```sh
git --version
node --version
pnpm --version
```

## Install

Run these from the folder where you want Vencord installed:

```sh
git clone https://github.com/Vendicated/Vencord
cd Vencord
git clone https://github.com/Alex7k/DiscordPgpEncryption src/userplugins/pgpEncrypt
pnpm install --frozen-lockfile
pnpm add -w openpgp
pnpm add -Dw @openpgp/web-stream-tools
pnpm build
pnpm inject
pnpm buildWeb   # only needed if you plan to use Discord in a browser
```

If you already have Vencord, start at `cd Vencord`.

## Use in a browser

`pnpm buildWeb` builds Vencord (with this plugin) as a browser extension into `dist/`.

Chrome / Chromium (Brave, Edge, ...):

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/chromium-unpacked` folder
4. Reload discord.com

The extension persists across browser restarts. After updating (see below), hit the reload arrow on the extension in `chrome://extensions` and refresh Discord.

Firefox: load `dist/extension-firefox.zip` as a temporary add-on via `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**. Note that temporary add-ons are removed when Firefox closes; installing it permanently requires Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to `false` in `about:config`.

Browser limitations: GIFs picked from the GIF picker are sent as encrypted links instead of encrypted files (there is no native process to download them through), and the picker-preview host permission prompt for favorited GIFs from unusual hosts is desktop-only.

## Update

Run these from your Vencord folder:

```sh
git pull --rebase --autostash
git -C src/userplugins/pgpEncrypt pull
pnpm install
pnpm build
pnpm inject
pnpm buildWeb   # only needed if you use Discord in a browser
```

Desktop picks up the update after a full Discord restart. For the browser, also reload the extension in `chrome://extensions` and refresh discord.com.

The `pnpm add` lines in the install step are needed because stock Vencord does not ship the OpenPGP dependencies this plugin uses.
