# Browser animation benchmark

Run this from the repo root.

```sh
node test/anim/run.mjs
```

The command prints JSON and releases port 4640 when it exits. It starts a dedicated Loupe daemon with a temporary copy of the demo fixture's `home` directory and runs Chrome headless over CDP. The runner expects the `loupe-demo` fixture in the system temporary directory, installed repo dependencies, and Chrome in the macOS Applications folder. The daemon’s recursive file watcher needs macOS file-event access. The benchmark uses the fixture’s GitHub stub, disables automatic file notes, and blocks browser requests to external services.

Pass a JSON path as the first argument to save the scores. The second argument can be `motion` or `theme` to run one part. A third argument saves five Chrome screencast frames to that directory. Set `LOUPE_ANIM_DPR=2` for a 2× backing scale or `LOUPE_ANIM_CHROME` to use another Chrome binary.

For the before scores, use the same driver with `LOUPE_ANIM_ROOT` pointing to a temporary archive of revision `0a49727` that can resolve the repo’s dependencies. It starts the archive’s daemon with the same fixture and measures it with the same cases. The archive run records feature checks without requiring the new behavior.

The driver samples DOM geometry and computed opacity, plus animated paint values when relevant. For canvas effects it samples coverage and brightness from a downscaled image. The theme samples include every active rAF interval in milliseconds. The screencast runs separately so encoding and CDP transfer do not affect the timing samples.
