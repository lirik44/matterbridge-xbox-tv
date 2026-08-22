# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-08-21

First release: a port of `homebridge-xbox-tv` to Matterbridge.

### Added

- Xbox consoles over both of their protocols: the local SmartGlass protocol on UDP 5050 for state, waking and
  shutting down, and the Xbox Live console command service for everything else.
- The SmartGlass packet layer ported field for field — the ECDH key exchange against the console certificate,
  the AES-128-CBC session encryption with a per-message initialization vector, the HMAC signature, the
  acknowledgement heartbeat and the fourteen second inactivity watchdog. Verified byte for byte against the
  original implementation.
- The Xbox Live token chain — Microsoft account token, user token, XSTS token — kept in the plugin storage and
  refreshed by itself. It can be started from an authorization code (`webApi.token`) or taken over from a
  `homebridge-xbox-tv` token file (`webApi.tokensFile`).
- Power as an outlet: the cloud `WakeUp` and `TurnOff` commands, falling back to the local wake packet and the
  local shutdown message, so a console with `webApi` turned off can still be switched on and off.
- Every game and app as its own outlet, as a radio group. Tapping one while the console is off wakes it and
  starts the game once it has booted, repeating the launch until it sticks.
- The apps every console has — dashboard, settings, TV settings, accessories, network troubleshooter, Microsoft
  Store, Xbox guide, live TV, screen saver — always exposed, each sent as the shell command that actually
  reaches it rather than as a launch by product id.
- Games and apps read from the console (`inputs.getFromDevice`), filtered by kind, capped at `inputs.maxCount`,
  cached between restarts, and registered without a restart when new ones appear.
- Volume and mute as a dimmer or, to stay clear of "turn off all the lights", as a fan. The console takes no
  absolute volume, so the slider sends one relative step per `volume.step` percent and the plugin remembers
  where it left off.
- Momentary outlets for media keys, gamepad keys, the TV remote volume keys, `reboot` and `recordGameDvr`, and
  for starting a game by product id.
- Occupancy and contact sensors mirroring the console state — a particular game, power, volume, mute, screen
  saver, playing — with an optional half-second pulse on change.
- Both shapes of the `sensors` section: the current list and the older set of booleans.
- The Homebridge option names throughout, including the numeric `displayType` values, so a configuration can be
  pasted across.

### Notes

- `restFul` and `mqtt` are not implemented: Matterbridge has its own frontend and WebSocket API.
- `inputs.displayOrder` and `infoButtonCommand` only meant something under HomeKit and are read and ignored.
- Endpoint serial numbers use a hash of the AUMID rather than a shortened one, because AUMIDs differ near the
  front — `Xbox.Settings.Application` and `Xbox.TvSettings.Application` end identically.
