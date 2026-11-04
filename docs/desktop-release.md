# Desktop builds and releases

> [!NOTE]
> The desktop application has migrated from Electron to Tauri (Tauri 2). Packaging, signing, notarization, and automated release workflows are currently being retargeted to Tauri and are not yet fully ported.

## Platforms

| Platform | Host / Architecture | Packages | In-app update |
|---|---|---|---|
| macOS | Tauri (Rust host) / Apple Silicon | `.app` / DMG | `tauri-plugin-updater` |
| Windows | Tauri (Rust host) / x64 | NSIS / MSI | `tauri-plugin-updater` |
| Linux | Tauri (Rust host) / x64 | AppImage / `.deb` | `tauri-plugin-updater` |

Package targets, permissions, window configuration, and updater settings live in [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) and [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml).

The custom app bar stays across platforms. macOS uses left-side native window buttons (`titleBarStyle: "Overlay"` in `tauri.conf.json`). Windows/Linux use native window decorations or client controls as configured.

Icons are per-platform: macOS compiles `build/icon.icon` / uses `build/icon.icns`; Windows embeds `build/icon.ico` and Linux uses `build/icon.png`. Linux's desktop identity is `ai.learnharness.desktop`.

## Build commands

For local development and building:

```sh
# Development mode with hot reloading:
npm run desktop:dev    # runs "tauri dev"

# Build debug/release binary:
npm run desktop:dist   # runs "tauri build"
```

## In-app updates

Updates are managed via `tauri-plugin-updater` pointing to GitHub Releases for `amosblomqvist/learnharness`.

Packaged apps check at startup and every 24 hours by default (when `autoUpdate` is not set to `false` in `settings.json`), download available updates, and prompt to restart. **Settings → General** displays update status, manual check, and automatic update toggle. Development builds report updater as disabled.
