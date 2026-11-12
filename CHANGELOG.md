# Changelog

All notable changes to Message Flow are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0]

First public release.

### Added
- Routing map for the OIE web administrator: Channel Writer destinations and `routeMessage()` / `routeMessageByChannelId()` script routes.
- Overview of channel-to-channel routes, channels with no inbound route, and routes that cannot be traced.
- Per-message trace showing where one message actually went.
- "View in Message Flow" action on a channel's right-click menu.
- **"Trace in Message Flow" action on a message row's right-click menu** in the Messages view. Opens Message Flow with the channel and message ID filled in and the trace already run. Needs Web Support 1.2.x or later; on older Web Support the action is skipped and the rest of the plugin loads normally.
- Optional integration with OIE Source Code Search for script route locations and code-template routing.

### Compatibility
- Open Integration Engine 4.6.0 and 4.7.0 (`<mirthVersion>4.6.0,4.7.0</mirthVersion>`; OIE requires an exact match against the listed versions).
- Requires Web Support. Source Code Search is optional but recommended.

### Acknowledgements
Thanks to [@gibson9583](https://github.com/gibson9583) (Web Support) and [@pacmano1](https://github.com/pacmano1).
