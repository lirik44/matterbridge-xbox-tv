<p align="center">
    <img src="matterbridge.svg" alt="Matterbridge Logo" width="64px" height="64px">
    <img src="xbox.jpg" alt="Xbox logo" width="64px" height="64px">
</p>

<h1 align="center">Matterbridge Xbox TV Plugin</h1>

<p align="center">
    <a href="https://www.npmjs.com/package/matterbridge">
        <img src="https://img.shields.io/badge/powered%20by-matterbridge-blue" alt="powered by matterbridge">
    </a>
    <a href="#how-it-talks-to-the-console">
        <img src="https://img.shields.io/badge/powered%20by-SmartGlass-blue" alt="powered by the SmartGlass protocol">
    </a>
    <a href="#how-it-talks-to-the-console">
        <img src="https://img.shields.io/badge/powered%20by-Xbox%20Live-blue" alt="powered by the Xbox Live Web API">
    </a>
</p>

---

**Matterbridge Xbox TV Plugin** is a dynamic platform plugin for
[Matterbridge](https://www.npmjs.com/package/matterbridge) that exposes Xbox consoles over Matter. It watches
the console over its own SmartGlass protocol on the local network and sends commands through Xbox Live, which
is the split Microsoft left behind — see [How it talks to the console](#how-it-talks-to-the-console).

It is a port of [`homebridge-xbox-tv`](https://github.com/grzegorz914/homebridge-xbox-tv). The option names are
unchanged, so an existing Homebridge configuration can be pasted across almost verbatim — see
[Coming from the Homebridge plugin](#coming-from-the-homebridge-plugin).

## Why the console is a set of outlets

Matter does define a television. `BasicVideoPlayer` (0x0028) carries media playback, keypad input and a media
input list — on paper, close to what a console needs.

No controller renders it. Apple Home, Google Home and Alexa all ignore the media device types; Matterbridge's
own documentation lists "Basic Video Player and Speaker" among the types Alexa fails to recognise. A console
published that way would simply not appear in your home.

So this plugin takes the console apart instead. Every function becomes a device type that every controller does
render — an outlet, a light or a sensor. That is the same fallback the Homebridge plugin uses for the parts
HomeKit's television service could not hold.

## What you get

Per configured console, each switched on by the option in the last column:

| Console function          | Matter device                | Shown as         | Option                |
| ------------------------- | ---------------------------- | ---------------- | --------------------- |
| Power                     | Outlet                       | `<console>`      | `power.displayType`   |
| Each game and app         | Outlet, mutually exclusive   | `<game name>`    | `inputs.displayType`  |
| Volume and mute           | Dimmer (or fan)              | `<name> Volume`  | `volume.displayType`  |
| Keys and console commands | Momentary outlets            | as named         | `buttons`             |
| State for automations     | Occupancy or contact sensors | as named         | `sensors`             |

Every one of these is its own bridged device rather than a child endpoint, because Apple Home does not render
the children of a composed device — a hidden game would be unreachable.

### How the game switches behave

The game and app outlets are a radio group: turning one on starts it and the others go off by themselves.
Turning one off does nothing, since "not running Sea of Thieves" is not a state a console can be put into —
start something else instead.

Tapping a game while the console is off wakes it first and then starts the game once it has booted. The launch
is repeated until it sticks, because the dashboard takes the foreground as the console finishes starting up.

The apps every console has — dashboard, settings, TV settings, accessories, network troubleshooter, Microsoft
Store, Xbox guide, live TV and the screen saver — are always in the list, so there is something to switch to
before the console has ever been reached.

### The volume

Neither protocol reports the volume, and neither takes an absolute one: all the console understands is one step
up or one step down, which it passes on to your TV or receiver over HDMI-CEC or infrared. So the slider
position is a number the plugin keeps, and moving it sends as many steps as the difference is worth —
one step per `volume.step` percent, 5 by default, capped at twenty steps per move. Switching the device off
mutes and switching it on unmutes.

`"volume": { "displayType": "fan" }` publishes it as a fan instead of a dimmer: the same control, but not swept
up by "turn off all the lights".

## Installation

```bash
npm install -g matterbridge-xbox-tv
matterbridge -add matterbridge-xbox-tv
```

Or from a checkout:

```bash
npm install
npm run build
npm run matterbridge:add
```

### On the console

Two settings decide whether any of this works:

1. **Settings → General → Power options → Sleep** (rather than "Full shutdown" / "Energy saving"). A console in
   full shutdown hears nothing, so it can never be turned on.
2. **Settings → Devices & connections → Remote features → Enable remote features**: on. This is what lets Xbox
   Live pass commands to the console; without it the plugin can see the console but not control it.

Give the console a static DHCP lease, and note its **Xbox network device ID** from
**Settings → System → Console info** — that is the `xboxLiveId`, sixteen hexadecimal digits.

### Authorization

Everything but power and state goes through Xbox Live, which needs a Microsoft account that the console belongs
to. There are two ways to get the plugin authorized, and both only have to happen once:

**Take it over from Homebridge.** If you already run `homebridge-xbox-tv`, point the plugin at its token file:

```json
"webApi": { "enable": true, "tokensFile": "/var/lib/homebridge/xboxTv/authToken_19216811172" }
```

The file is read once and copied into the plugin's own Matterbridge storage; nothing is written back to it, so
the Homebridge plugin keeps working. The name of the file is `authToken_` plus the console address with the dots
removed.

**Or authorize from scratch.** Leave `webApi.token` empty and start the plugin: it logs a `login.live.com`
address. Open it, sign in, and you land on a `localhost:8888` page that does not exist — that is expected. Copy
the whole address out of the address bar, or just its `code=` parameter, into `webApi.token` and restart:

```json
"webApi": { "enable": true, "token": "M.C5xx_BAY.2.U.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
```

The code is spent the moment it is used and expires within minutes, so a code that already went through
Homebridge will be refused — get a new one. After that the plugin keeps its own token chain in the Matterbridge
storage and refreshes it by itself; `webApi.token` can stay in the configuration or be removed.

With `"webApi": { "enable": false }` the plugin still works, but only for power and state: launching a game,
pressing a key and changing the volume are cloud commands.

## Configuration

The smallest configuration that does something useful:

```json
{
  "name": "matterbridge-xbox-tv",
  "type": "DynamicPlatform",
  "devices": [
    {
      "name": "XBOX",
      "host": "192.168.1.172",
      "xboxLiveId": "F4000E3B77208078",
      "webApi": { "enable": true, "token": "PASTE THE AUTHORIZATION CODE HERE ONCE" }
    }
  ]
}
```

`config.example.json` carries a fuller one. Every option is documented in the Matterbridge frontend, from
`matterbridge-xbox-tv.schema.json`.

### Games and apps from the console

With `"inputs": { "getFromDevice": true }` the plugin asks Xbox Live for the games and apps installed on the
console instead of taking the list from the configuration. Two things to know:

- A console reports everything installed, and each entry is a device in your home. The list is therefore capped
  at `inputs.maxCount` (20 by default) and the plugin logs what it dropped. Alexa stops working past 50 bridged
  devices in total. `filterGames`, `filterApps`, `filterSystemApps` and `filterDlc` narrow it down first.
- The list only arrives once Xbox Live answers. Entries that show up later are registered without a restart,
  and are cached so that they are there immediately next time.

For a fixed set — which is what most people want — leave `getFromDevice` off and list them under `inputs.data`:

```json
{
  "name": "Sea of Thieves",
  "reference": "Microsoft.SeaofThieves_8wekyb3d8bbwe!Game",
  "oneStoreProductId": "9PGW18NPBZV5",
  "contentType": "Game"
}
```

The `reference` is the AUMID, which is what the console reports as the running title, so it is what makes the
switch light up by itself. The `oneStoreProductId` is what a launch command takes, so without it the switch can
show the game but not start it. The easiest way to get both is to turn `getFromDevice` on once with `debug`, read
them out of the log, and turn it back off.

### Buttons

A button is a momentary outlet: it fires one command and turns itself off a second later. `mode` says what kind
of command, and the field that matches it is the one that is read:

| `mode` | Field                   | What it does                                                              |
| ------ | ----------------------- | ------------------------------------------------------------------------- |
| `0`    | `mediaCommand`          | A media key: `play`, `pause`, `nextTrack`, `prevTrack`, `stop`, and so on. |
| `1`    | `gamePadCommand`        | A gamepad key: `nexus` (the Xbox button), `a`, `b`, `menu`, `view`, …      |
| `2`    | `tvRemoteCommand`       | `volUp`, `volDown` or `volMute`, sent to your TV or receiver.              |
| `3`    | `consoleControlCommand` | `reboot`, or `recordGameDvr` to keep the last minute of play as a clip.    |
| `4`    | `gameAppControlCommand` | Starts the game or app with that product id.                              |

`recordGameDvr` is the one command that goes over the local network rather than through the cloud, and the one
that needs a local session opened with an Xbox Live token, which means `webApi` has to be authorized even though
the command never leaves your network.

### Sensors

A sensor mirrors one part of the console state so that automations can react to it. `mode` says what it
watches: `0` a particular game or app (which needs a `reference`), `1` power, `2` volume (which needs a
`level`), `3` mute, `4` the screen saver, `5` whether something is playing.

Matter has no motion sensor of its own, so a sensor is either an occupancy sensor (reports "occupied" while the
condition holds) or a contact sensor (reads closed normally and opens when it triggers). With `"pulse": true`
it instead reports for half a second on every change, which is what you want for "the game changed".

## How it talks to the console

Two protocols at once, which is not a design choice but what is left:

**The local one — SmartGlass, UDP port 5050.** A discovery request asks the console to announce itself; the
announcement carries a certificate, and an ECDH exchange against its public key derives the session key. A
connect request then opens a session, carrying the Xbox Live token when there is one, and from then on the
console reports what it is running every few seconds and expects each of those reports to be acknowledged.
Fourteen seconds of silence means the console is gone, and the plugin goes back to sending discovery requests
every `heartBeatInterval` seconds until it answers again.

This is what tells you within seconds that the console was switched on, or that someone started a game with the
controller. It also wakes the console — the one packet a console in standby listens for — and can shut it down.
What it can no longer do is launch a title or press a key: Microsoft removed those from the local protocol.

**The cloud one — Xbox Live, `xccs.xboxlive.com`.** Three tokens, each obtained with the one before it: a
Microsoft account token, an Xbox Live user token, and an XSTS token, which is the one that opens doors. Every
command — launch, key press, volume, mute, reboot, wake, shut down — is a POST to `/commands`. The plugin also
reads the console state from there, but only every `pollInterval` seconds (300 by default): Microsoft throttles
a client that asks more often, and the local protocol already answers that question faster.

Power commands try the cloud first and fall back to the local protocol, so a console with `webApi` turned off
can still be switched on and off.

## Coming from the Homebridge plugin

Paste the `devices` array across. Every option is accepted, including the numeric `displayType` values and the
older shape of the `sensors` section, where each sensor was a boolean rather than a list entry.

Read and ignored, because they only meant something under HomeKit:

| Option                | Why                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `displayType`         | The HomeKit accessory category. Matter has no console category to set — but a `0` still means "do not expose".        |
| `inputs.displayOrder` | The controller app decides the order of bridged devices.                                                             |
| `infoButtonCommand`   | It bound the HomeKit remote's ⓘ button, and Matter has no remote widget. Expose the key as a `buttons` entry instead. |
| `log.*`               | Matterbridge owns the log levels; only `log.debug` is honoured, as `debug`.                                          |

Not implemented:

| Option    | Why                                                  |
| --------- | ---------------------------------------------------- |
| `restFul` | Matterbridge has its own frontend and WebSocket API. |
| `mqtt`    | Same.                                                |

Behaviour that changed:

- **The authorization lives in the Matterbridge storage**, not in a file under the Homebridge directory, and
  there is no configuration UI to click through — `webApi.token` or `webApi.tokensFile` does the same job. See
  [Authorization](#authorization).
- **`volume.displayType` values `3` to `5`** were the HomeKit speaker services, which Matter has no counterpart
  for; they become the lightbulb the same plugin falls back to. `0` still means "not exposed".
- **A `displayType` of `2`** (a HomeKit switch) becomes an outlet: Matter's switch device type carries a client
  cluster and does not show up as a switch in several controllers.
- **Motion sensors become occupancy sensors**, as Matter has no motion sensor.
- **The TV remote keys go to the volume channels** (`Volume/Up`, `Volume/Down`, `Audio/Mute`) rather than being
  injected as key presses, which is what actually reaches the TV.
- **`inputs.data` entries need a product id to be launchable.** Under HomeKit the same was true, but the
  failure was silent; here the plugin says so.
- **`contentType`** is compared without case or spaces, so both `System App` (what the Homebridge form offers)
  and `systemApp` (what the console reports) are caught by `filterSystemApps`.

## Known limitations

- **Commands need the cloud.** A console that Microsoft cannot reach — no internet, or remote features turned
  off — can be watched, woken and shut down, but not told to do anything else. The plugin says which of the two
  it is.
- **The volume is open loop.** The console never reports a volume, so the slider is where the plugin last left
  it, not where your receiver actually is. Changing the volume with the TV remote will drift the two apart.
- **Playing or paused comes from the cloud**, so a `playState` sensor only changes as often as `pollInterval`.
- **One console per Xbox Live account is assumed** to the extent that the account has to own the console; a
  console belonging to somebody else's account cannot be authorized.

## Development

```bash
npm install            # install dependencies
npm run build          # compile TypeScript to dist/
npm run lint           # eslint, no warnings allowed
npm run format:check   # prettier
```

## License

Apache-2.0. The SmartGlass packet layout, the Xbox Live endpoints, the OAuth client id and the default app list
come from [`homebridge-xbox-tv`](https://github.com/grzegorz914/homebridge-xbox-tv) by grzegorz914 (MIT). Xbox
and Microsoft are trademarks of Microsoft Corporation; this plugin is not affiliated with Microsoft.
