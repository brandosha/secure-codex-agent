# secure-codex-agent

## Tool configuration

The tools service loads `tools/config.ts` when it exists. If it does not exist,
it falls back to the tracked `tools/config.default.ts`.

To customize a clone:

```sh
cp tools/config.default.ts tools/config.ts
```

Then edit `tools/config.ts` to choose which tools to run and how they should be
configured. `tools/config.ts` is ignored by Git so local tool choices and
credentials do not get committed.

The tools service also loads environment variables with `dotenv`, so you can
still put secrets in a local `.env` file and read them from `config.ts` with
`process.env`.
