# Stashpool

**One big storage pool from many free cloud accounts — that survives losing an account.**

Tools like rclone `union`, CloudNest and Drive-Pool already merge several Google Drive accounts into one place.
But if one of those accounts gets closed, suspended or locked, every file stored in it is gone.

Stashpool adds **parity** (the idea behind RAID 5): each file is split across N accounts plus one parity piece.
If any one account disappears, its pieces are rebuilt from the others.

| Accounts (15 GB each) | Raw space | Usable with 1 parity | Survives |
|---|---|---|---|
| 3 | 45 GB | 30 GB | any 1 account lost |
| 5 | 75 GB | 60 GB | any 1 account lost |
| 10 | 150 GB | 135 GB | any 1 account lost |

Copying every file twice would halve your space. Parity only costs one account's worth.

> Use your own accounts. Stashpool is not a tool for mass-creating accounts.

**Try it in the browser:** https://stashpool.pages.dev — files are encrypted on your device (AES-256-GCM) and go straight to your own Google Drive accounts; no server ever sees them.

_The project started under the Turkish name "havuz" (pool); the command-line tool and the Drive folder still use that name._

## Status

Early. Built in public, one step a day.

- [x] Day 1: connect Google Drive accounts with a device code (no browser needed on the machine), show free space
- [x] Day 2: put / get / ls / rm for files and whole folders (zipped on the fly, nothing written to disk); SHA-256 checked on the way back
- [x] Day 3: XOR parity across accounts (rotating, RAID 5 style); full accounts drop out of new stripes so one small account never caps the pool; `--without` proves recovery
- [ ] Rebuild a lost account onto a new one
- [ ] Reed-Solomon: survive losing 2+ accounts
- [ ] Dropbox, OneDrive
- [ ] Web UI

## Build

Only the Go standard library is used.

```
go build -o havuz .
```

## Use

```
havuz setup        # paste your Google OAuth client ID and secret (once)
havuz add main     # prints a code; enter it at google.com/device on any device
havuz add backup1
havuz list         # every account, free space, and usable space with parity
havuz put photo.jpg   # split into chunks, spread over the accounts
havuz ls              # files in the pool
havuz get photo.jpg copy.jpg   # rebuild and verify
havuz get photo.jpg copy.jpg --without backup1   # pretend backup1 is gone: rebuilt from parity
havuz rm photo.jpg
```

You need your own Google Cloud OAuth client of type **TVs and Limited Input devices**.
havuz only asks for the `drive.file` scope: it can see the files it created, nothing else in your Drive.

## License

MIT

## Hosting the web app yourself

The site is static (`web/`) plus one tiny function that adds the Google client secret to token requests (`lib/token.mjs`). It runs on Cloudflare Pages (`functions/api/token.js`) or Netlify (`netlify/functions/token.mjs`). Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DEVICE_CLIENT_ID` and `DEVICE_CLIENT_SECRET` in the host's environment settings.
