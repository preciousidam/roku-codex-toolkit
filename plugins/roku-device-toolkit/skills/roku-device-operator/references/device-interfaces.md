# Roku device interfaces

## Interfaces

| Purpose | Port | Interface |
| --- | ---: | --- |
| Device/app/player queries, keypresses, text, launch | 8060 | External Control Protocol (ECP), no developer password |
| Development installer and screenshot utility | 80 | HTTP Digest authentication, user `rokudev` |
| BrightScript debug console | 8085 | Plain TCP console for the sideloaded app |

ECP is intended for local-network control. A `403` commonly means the caller is outside the Roku device's trusted local network path, even if the TCP port is reachable.

## Common ECP endpoints

- `GET /query/device-info`
- `GET /query/apps`
- `GET /query/active-app`
- `GET /query/media-player`
- `POST /keypress/{key}`
- `POST /launch/{channelId}` with optional `contentId` and `mediaType` query parameters

Text entry is a sequence of `keypress/Lit_` requests with each UTF-8 character URL-encoded.

## Developer-mode behavior

- Only one development app can be sideloaded. Installing another ZIP replaces it.
- The installer and screenshot utility require developer mode and the password created on the device.
- The screenshot utility captures app UI, not protected/video playback. Typical output is 1280x720; capable 4K devices configured for 1080p/4K may produce 1920x1080.
- Sideloaded apps use channel ID `dev` for ECP launch.
- The debug console on port 8085 is associated with the currently sideloaded development app.

## Secrets and evidence

Store the developer password only in `ROKU_DEV_PASSWORD`. Redact auth tokens, account data, license URLs, and credential fields from screenshots and logs before sharing them. Record the device model/version from `info` when runtime behavior may vary by Roku OS.
