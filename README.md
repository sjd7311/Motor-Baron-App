# Motor Baron – iPhone app

This folder builds two iPhone apps from the same game:

- **Motor Baron** – full game, 1900–1970 (`com.spencerdeville.motorbaron`)
- **Motor Baron: 1900** – free edition, ends December 1915 (`com.spencerdeville.motorbaron.free`)

The game itself is `src/game.html`. To update the apps, replace that file and start a new build in Codemagic.
Builds run on Codemagic's cloud Macs (see `codemagic.yaml`) and go straight to TestFlight.
