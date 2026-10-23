# Dianis ♥

Send each other GIFs with a little message. Received GIFs pop up in the bottom-right corner of the
screen with the text in a speech bubble above them, then fade away.

```
server/   tiny WebSocket relay (deploy once, both apps connect to it)
app/      Windows desktop app (Electron): tray icon, compose window, corner overlay
```

## How it works

- Both apps connect to the relay with the **same room code** (a shared secret) and their own name.
- Sending picks a GIF, reads its file and sends it with the text. The other app shows it in the overlay.
- If the other person is offline, the relay keeps the message (up to 30, for 7 days, in memory)
  and delivers it when they connect.
- **Use GIFs with a transparent background.** The app shows them exactly as they are, so a GIF
  with a white (or any other solid) background appears as a box in the corner.
- The overlay is click-through. Hovering over it pauses it and shows **Reply**, **Save GIF** (copies
  a received GIF into your own collection) and **✕**.

## 1. Deploy the relay (once)

Any host that runs Node 18+ and supports WebSockets works. With **Render** (free):

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → pick the repo.
3. Root directory: `server`, build command: `npm install`, start command: `npm start`.
4. Optional, for extra safety: add the environment variable `ROOMS=<your room code>` so that only
   your room is accepted.
5. Use the service URL (e.g. `https://dianis-relay.onrender.com`) as the server address in the app.

Free Render instances go to sleep after about 15 minutes without traffic. The apps ping every 25
seconds while running, so it stays awake while either of you has the app open. The first connection
after it sleeps can take around 30 seconds, and **queued messages are lost when the server sleeps
or restarts**. For always-on delivery, use a paid instance or any small VPS:
`cd server && npm install && PORT=8080 npm start` (behind HTTPS if possible).

## 2. Install the app

The installer is at `app/dist/Dianis-Setup-<version>.exe`. Run it on both PCs. Windows SmartScreen will
warn because the installer is not code-signed: click **More info → Run anyway**.

On first start, Settings opens:

| Field | Value |
|---|---|
| Your name | what the other person sees above your messages |
| Server address | the relay URL, e.g. `https://dianis-relay.onrender.com` |
| Room code | click **Generate** on one PC, then type the **same** code on the other |
| Start with Windows | keeps the app running in the tray so messages always arrive |

Closing the window keeps the app running in the tray (heart icon). Use **Quit** in the tray menu to
exit.

## The window

Top to bottom: **＋ Add GIFs**, **★ Favourites**, **Our GIFs**, **My GIFs**.

- **Favourites**: hover any GIF and click **☆** (top-left). Click **★** again to remove it. Favourites
  are stored per PC in `config.json`.
- **History** (button in the header): the last 10 GIFs you received with their message, sender and
  time, newest first. Kept in `%APPDATA%\dianis\history`, so they survive restarts. Click a row to see
  it in the corner again; **Save GIF** copies it into My GIFs, **☆** saves it and adds it to Favourites.

## Updates

The app checks GitHub Releases of `Renis032/DianisCommunication` at start and every 4 hours, and
downloads new versions in the background. When an update is ready:

- if the window is open, a bar offers **Restart now** (the tray menu has the same item);
- otherwise it installs on its own as soon as the window is closed or minimised and no message is on
  screen, then restarts quietly in the tray.

Auto-update only works with the **installer** (`npm run dist`), not the portable `.exe`. Version
1.0.0 has no updater, so install 1.1.0 by hand once on both PCs; every later version arrives by
itself.

### Publishing a new version

1. Bump `"version"` in `app/package.json` (e.g. `1.1.0` → `1.2.0`). The app only updates to a higher
   version.
2. Build: `cd app && npm run dist`.
3. On GitHub: **Releases → Draft a new release**, tag `v1.2.0`, and upload these three files from
   `app/dist/`: `Dianis-Setup-1.2.0.exe`, `Dianis-Setup-1.2.0.exe.blockmap`, `latest.yml`.
   Then click **Publish release**. Do not mark it as a pre-release.

Or let the build upload them: create a GitHub token with `repo` scope, then
`GH_TOKEN=<token> npm run release`. This creates a **draft** release; open it on GitHub and click
**Publish release**.

## Adding GIFs

- **Built-in GIFs** (both of you get them): put files into `app/gifs/` and rebuild the installer.
  Delete the two `sample-*` GIFs if you don't want them.
- **Removing GIFs in the app**: hover a GIF and click **✕**. Your own GIFs are deleted. Built-in GIFs
  are only hidden on that PC, because their files come with the installer and would come back on
  reinstall. Click **Restore** under "Our GIFs" to show them again.
- **Your own GIFs**: in the app, click **＋ Add GIFs** (top of the window) or drag files into the window. They're stored
  in `%APPDATA%\dianis\my-gifs`. The GIF itself is sent with every message, so the other person
  doesn't need to have it. Max 12 MB per GIF. `.gif`, `.webp` and animated `.png` are supported.

## Development

```bash
cd server && npm install && PORT=8080 npm start
cd app && npm install && npm start
npm run dist            # Windows installer + latest.yml → app/dist/
npm run dist:portable   # single portable .exe instead (no auto-update)
npm run release         # build and upload to a draft GitHub release (needs GH_TOKEN)
```

Building on Linux needs `wine`. On Windows, `npm run dist` works directly.
