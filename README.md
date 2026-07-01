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

## Egress proxy

The `agent` and `browser` services do not have direct public network egress.
They are configured to send HTTP and HTTPS traffic through the `egress-proxy`
service, which runs Envoy with a default-deny allowlist.

The tracked default allowlist lives at
`egress-proxy/policy/allowlist.default.txt`. To customize a clone, create a
local override:

```sh
cp egress-proxy/policy/allowlist.default.txt egress-proxy/policy/allowlist.txt
```

`egress-proxy/policy/allowlist.txt` is ignored by Git because it is local
security policy. The proxy compiles that file into Envoy RBAC rules at startup.
If the local file is missing, it falls back to the tracked default allowlist.

Each non-comment line must be an exact `host:port` entry:

```txt
api.openai.com:443
```

For default HTTP and HTTPS ports, the compiler also allows the bare host form
that clients commonly send in `Host` or `:authority`:

```txt
example.com:443
```

This allows both `example.com:443` and `example.com`. Broad entries weaken the
exfiltration boundary, so avoid allowing whole hosting providers, URL
shorteners, paste sites, or arbitrary wildcard domains.

If outbound access fails:

1. Check the active allowlist with
   `cat egress-proxy/policy/allowlist.txt` or
   `cat egress-proxy/policy/allowlist.default.txt`.
2. Validate Compose with `docker compose config`.
3. Check Envoy logs with `docker compose logs egress-proxy`.
4. Add the narrowest exact domain needed by the denied request, then restart
   the proxy with `docker compose restart egress-proxy`.
