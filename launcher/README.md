# universal-docs

The self-improving install of [Universal Docs](https://github.com/scottpersinger/universal-docs), a desktop app for spreadsheets, documents and presentations with a built-in assistant. Installed this way the app runs from its own source, so when the assistant lacks a capability it can add it to the app: a coding agent changes the code, runs the checks, and the app restarts with the change.

```
npm install -g universal-docs
cd ~/Documents && universal-docs     # open the folder you are in, or name one: universal-docs ~/Documents
```

The first run clones the app's source into `~/.universal-docs/app` at the newest release, installs its dependencies and builds it, which takes a few minutes. Needs Node 24 or later and git. The assistant uses `ANTHROPIC_API_KEY` from your shell, or a key you enter in the app's Settings.

- `universal-docs update` moves your changes onto the newest release and rebuilds. If they conflict, nothing changes and it tells you where to resolve it.
- `universal-docs where` prints where the source is.

Every change the assistant makes is a commit on the `my-changes` branch of that checkout, so `git log` there is the history of your copy of the app, and you can change it yourself too. Changes it could not verify (the type check, the tests, the app starting again) are put back.

Prefer an app whose code does not change? Download the bundled app from the [releases](https://github.com/scottpersinger/universal-docs/releases/latest).
