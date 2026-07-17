# @lemonize/cli

The official CLI for [Lemonize](https://lemonize.cyou), a public package distribution platform and npm pull-through CDN.

```sh
npm install --global @lemonize/cli
lem login
lem add @namespace/package --source lemonize
lem add is-number
```

`lem` publishes native Lemonize packages and recursively installs both Lemonize and public npm dependency graphs. Native packages use `lemonizeDependencies`; standard `dependencies` use the read-only npm CDN proxy. Lockfile version 2 records both sources and exact integrity data. `lemx` runs an installed package binary.

Public publishing requires a GitHub-linked Clerk account, current terms acceptance, and a package named for the account's Lemonize namespace. Production remains read-only until the documented cutover gates pass. See the [CLI documentation](https://lemonize.cyou/docs) for authentication, source selection, frozen installs, token commands, and publishing status.

The installer never runs package lifecycle scripts. Review packages before executing their binaries.
