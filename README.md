# Pinned Notes to Top

Pin notes to the top of their folder in the Obsidian file explorer. Pinned notes appear above all other items regardless of your sort order (name, created, modified).

## Features

- **Pin any note to the top of its folder** — pinned notes always appear first in the file explorer
- **Context menu integration** — right-click any file in the explorer to pin or unpin it
- **Command palette** — pin/unpin the currently active note via command
- **Ribbon icon** — quick one-click pin for the active note
- **Persists across sessions** — pin settings are saved in the plugin's data file
- **Survives renames and moves** — pinned references follow files as they're reorganized
- **Auto-cleanup** — deleted notes are automatically removed from pin lists
- **No sort-order dependency** — works with any sort setting (name, created, modified, reverse)

## Usage

### Pinning a Note

1. **Via context menu** — Right-click a file in the file explorer and select "📌 Pin to top of folder"
2. **Via command palette** — Open any note, run `Pinned Notes to Top: Pin to top of folder`
3. **Via ribbon icon** — Click the pin icon in the left sidebar to pin the active note

### Unpinning a Note

1. **Via context menu** — Right-click a pinned file and select "📍 Unpin from top"
2. **Via command palette** — Run `Pinned Notes to Top: Unpin from top of folder`

### Toggle Pin Status

Run `Pinned Notes to Top: Toggle pin status` to switch the pin state of the active note.

## Commands

| Command | ID | Description |
|---------|-----|-------------|
| Pin to top of folder | `pin-to-top` | Pin the currently open note to the top of its folder |
| Unpin from top of folder | `unpin-from-top` | Unpin the currently open note |
| Toggle pin status | `toggle-pin-status` | Toggle the pin status of the currently open note |

All commands can be assigned custom hotkeys in Settings → Keyboard Shortcuts.

## Installation

### From Community Plugins (Recommended)

1. Open Obsidian Settings → Community plugins
2. Click **Browse**
3. Search for **Pinned Notes to Top**
4. Click **Install** then **Enable**

### Manual Installation

1. Download the latest release from this repository
2. Extract the plugin folder (`pinned-notes-top`) into your vault's `.obsidian/plugins/` directory
3. Reload Obsidian (or click "Reload plugins" in Community plugins settings)
4. Enable **Pinned Notes to Top** in Community plugins

### Development / Build from Source

```bash
cd .obsidian/plugins/pinned-notes-top
npm install
npm run build   # or npm run dev for development mode with source maps
```

## Data Storage

Pin settings are stored in `.obsidian/plugins/pinned-notes-top/data.json` as:

```json
{
  "pinned": {
    "Folder Name": ["note1.md", "note2.md"],
    "Subfolder": ["important.md"]
  }
}
```

Each entry maps a folder path to an array of file paths, in the order you pinned them.

## Limitations

- Requires Obsidian 1.5.0 or later
- Only works in the default File Explorer view
- Pinned notes are pinned per-folder — a file can only be pinned in its current parent folder
- If a file is moved to a different folder, its pin follows but appears in the new folder's context

## License

MIT

## Author

Assistant
