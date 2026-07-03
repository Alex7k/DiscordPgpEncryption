# PgpEncrypt

A Vencord userplugin for sending and receiving PGP encrypted Discord DMs.

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
```

If you already have Vencord, start at `cd Vencord`.

## Update

Run these from your Vencord folder:

```sh
git pull --rebase --autostash
git -C src/userplugins/pgpEncrypt pull
pnpm install
pnpm build
pnpm inject
```

The `pnpm add` lines in the install step are needed because stock Vencord does not ship the OpenPGP dependencies this plugin uses.
