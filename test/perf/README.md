# Loupe performance harness

From the repo root, with Node 25 and Google Chrome installed:

```sh
node test/perf/run.mjs
```

The command runs five cold/warm pairs per fixture and includes a 60-second idle window on every navigation. Allow about half an hour. It prints the output directory and writes per-navigation `samples.json`, `medians.json`, and daemon and Chrome logs there. `--out DIR` picks the output directory. Use a fresh directory for each comparison.

- Cold starts a new daemon and a new Chrome profile. Warm navigates in the same tab after one complete pass, with the daemon and browser caches retained. macOS filesystem caches are retained across both.
- The daemon listens on `127.0.0.1:4650` with temporary state and mDNS and privileged ports disabled. Chrome uses a disposable profile and an OS-assigned CDP port. The small fixture is `/tmp/loupe-demo/ratelimit` and both fixtures use `/tmp/loupe-demo/gh`, fixed models, and isolated state with automatic file notes disabled. The large fixture is generated in a temporary Git repository. It includes 301 changed files, about 20,000 changed lines, three 3,300-line source files, two renames, a binary change, and tracked and untracked work. The harness removes its temporary state on exit.
- First paint is navigation to the first unfolded text diff's first paint opportunity. Viewport idle adds 350 ms without a finite API request or a diff/inspector DOM update. `allReadyMs` records that first quiet point if all unfolded bodies are ready, or uses the end of the sweep and revisits if the viewport check still found placeholders. `allIdleMs` always includes the steady 12,000 px/s top-to-bottom sweep, any revisits to skipped placeholders, and the final quiet window. Both exclude the separately measured idle and heap-snapshot time. Binary and folded cards count as ready once their normal UI is present.
- Scroll reports requestAnimationFrame intervals over 16.7 ms and the maximum interval, with Chrome Long Animation Frames and their script attribution in each sample. The interval percentage includes Chrome's own frame pacing and quantization around 16.7 ms. Scroll steps follow elapsed time and cap at half a viewport after a stall, so successive views overlap.
- Interaction timings use trusted CDP input and a task scheduled on the first animation frame that can paint the requested result. The viewer timing ends on the whole-file text. Layout toggles run after every diff body has been visited. The viewed mark is toggled off again before the warm run.
- Each request record has the exact URL, HTTP status, time to headers, time to completion, body bytes, and encoded transfer bytes when Chrome supplies them. The open and all-files phases have separate snapshots with the open requests included in both. The event stream contributes its handshake latency and bytes received through each snapshot.
- Idle reports cumulative CPU deltas for the daemon, Chrome renderer processes, and the page main-thread task clock. No harness polling or input runs during the idle window. Heap is V8 used heap after forced GC, after opening and after scrolling.

For a shorter exploratory run, use `--fixture small|large`, `--runs N`, or `--idle-seconds 0` to omit idle. `--profile` additionally records Chrome and Node CPU profiles and `GIT_TRACE2_PERF` from the first pair of each selected fixture. Use a separate profile run when comparing unprofiled medians. `LOUPE_PERF_CHROME` and `LOUPE_PERF_DEMO` override the Chrome executable and demo directory. On this Mac, launch outside the restricted workspace shell if macOS returns `EMFILE` from the daemon's recursive watcher.

Pass `--against DIR` to run the same driver and fixture against a baseline source tree and the current app. Each app gets a fresh daemon and Chrome profile for its cold/warm pair. The driver alternates app order across pairs and stores the variant in each sample. Both source trees need installed dependencies. `--app-root DIR` chooses the candidate source tree when running the driver from a different directory.
