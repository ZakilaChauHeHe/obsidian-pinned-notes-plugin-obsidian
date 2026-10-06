import { App, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, Setting, SettingTab } from 'obsidian';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PinnedNotePluginSettings {
	pinned: Record<string, string[]>; // folder path -> array of file paths pinned to top
}

const DEFAULT_SETTINGS: PinnedNotePluginSettings = {
	pinned: {},
};

// Obsidian's internal FileExplorerView is undocumented. We only shape the
// small slice we touch.  The plugin patches getSortedFolderItems on the shared
// prototype so every existing + future explorer view picks up the behaviour.

interface FileExplorerItem {
	file: TAbstractFile;
	selfEl: HTMLElement;
}

interface FileExplorerViewLike {
	getSortedFolderItems?: (folder: TFolder) => FileExplorerItem[];
	requestSort?: () => void;
}

type ProtoMethod = (this: FileExplorerViewLike, folder: TFolder) => FileExplorerItem[];

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class PinnedNotePlugin extends Plugin {
	settings: PinnedNotePluginSettings = DEFAULT_SETTINGS;
	private _uninstallPatch: (() => void) | null = null;

	// Whether the current file in the active leaf is pinned in its folder.
	private _pinnedStateCache: { path: string; pinned: boolean } | null = null;

	// ── Lifecycle ────────────────────────────────────────────────────────────

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file, source) => {
				this.handleFileMenu(menu, file, source);
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, _oldPath) => {
				this.onFileRenamed(file);
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				this.onFileDeleted(file);
			}),
		);

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				this.onFileCreated(file);
			}),
		);

		this.addCommand({
			id: 'pin-to-top',
			name: 'Pin to top of folder',
			editorCallback: () => this.togglePin(true),
		});

		this.addCommand({
			id: 'unpin-from-top',
			name: 'Unpin from top of folder',
			editorCallback: () => this.togglePin(false),
		});

		this.addCommand({
			id: 'toggle-pin-status',
			name: 'Toggle pin status',
			editorCallback: () => {
				const pinned = this.isFilePinned(this.app.workspace.getActiveFile());
				this.togglePin(pinned ? false : true);
			},
		});

		// Add ribbon icon for quick access
		this.addRibbonIcon('pin', 'Pin current note', () => {
			const file = this.app.workspace.getActiveFile();
			if (!file) return;
			this.togglePin(true);
		});

		this.addSettingTab(new PinnedNoteSettingTab(this));

		// Patch the FileExplorerView prototype so pinned items always sort to
		// the top of every folder in the explorer.
		this.patchExplorerPrototype();

		this.registerInterval(
			window.setInterval(() => {
				this._pinnedStateCache = null;
				this.refreshAllExplorerViews();
			}, 5000),
		);

		this.app.workspace.onLayoutReady(() => {
			this.refreshAllExplorerViews();
		});
	}

	async onunload(): Promise<void> {
		this.uninstallPatch();
		this._pinnedStateCache = null;
	}

	// ── Settings persistence ─────────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// ── Core logic ───────────────────────────────────────────────────────────

	/** Returns true if the given file is pinned in its parent folder. */
	isFilePinned(file: TAbstractFile | null): boolean {
		if (!file || !(file instanceof TFile)) return false;
		const folder = file.parent;
		if (!folder) return false;

		// Use cache to avoid repeated lookups during menu building.
		const key = this._fileKey(file);
		const cached = this._pinnedStateCache;
		if (cached && cached.path === key) return cached.pinned;

		const pinnedList = this.settings.pinned[folder.path];
		const pinned = pinnedList ? pinnedList.includes(key) : false;
		this._pinnedStateCache = { path: key, pinned };
		return pinned;
	}

	/** Returns the full list of pinned file keys for a folder (empty if none). */
	getPinnedInFolder(folder: TFolder): string[] {
		const pinnedList = this.settings.pinned[folder.path];
		return pinnedList ? [...pinnedList] : [];
	}

	/** Toggle the pin status for a file in its folder. */
	async togglePin(pin: boolean): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No file is currently open.');
			return;
		}

		const folder = file.parent;
		if (!folder) {
			new Notice('File has no parent folder — nothing to pin to.');
			return;
		}

		const key = this._fileKey(file);
		let pinnedList = this.settings.pinned[folder.path];
		if (!pinnedList) pinnedList = [];

		if (pin) {
			if (!pinnedList.includes(key)) {
				pinnedList.unshift(key); // add to top
			}
			this.settings.pinned[folder.path] = pinnedList;
			await this.saveSettings();
			new Notice(`📌 Pinned "${file.basename}" to top of ${folder.name}`);
		} else {
			const idx = pinnedList.indexOf(key);
			if (idx !== -1) {
				pinnedList.splice(idx, 1);
				this.settings.pinned[folder.path] = pinnedList;
				await this.saveSettings();
				new Notice(`📍 Unpinned "${file.basename}" from ${folder.name}`);
			} else {
				new Notice(`"${file.basename}" is not currently pinned.`);
			}
		}

		this._pinnedStateCache = null;
		this.refreshAllExplorerViews();
	}

	// ── Explorer prototype patching ──────────────────────────────────────────

	/**
	 * Monkey-patch `getSortedFolderItems` on the FileExplorerView prototype.
	 * Returns pinned items first, then the rest in Obsidian's default order.
	 */
	private patchExplorerPrototype(): void {
		// We need to find the FileExplorerView constructor. It's registered as an
		// internal plugin, so it lives on `this.app.internalPlugins.plugins`.
		// The actual constructor is accessed via the prototype chain.

		const findAndPatch = () => {
			// Try multiple ways to locate the FileExplorerView constructor.
			let proto: FileExplorerViewLike | null = null;

			// Method 1: internal plugins registry (most reliable)
			try {
				const plugins = (this.app as any).internalPlugins?.plugins as any[] | undefined;
				if (Array.isArray(plugins)) {
					for (const p of plugins) {
						if (p?.view) {
							const v = p.view;
							if (v && typeof v.getSortedFolderItems === 'function') {
								proto = v;
								break;
							}
						}
						// Sometimes the view is on `p.constructor` or `p.prototype`
						if (p?.constructor?.prototype && typeof (p.constructor.prototype as any).getSortedFolderItems === 'function') {
							proto = p.constructor.prototype;
							break;
						}
					}
				}
			} catch { /* ignore */ }

			// Method 2: scan workspace leaves for an open file explorer
			if (!proto) {
				const leaves = this.app.workspace.getLeavesOfType('file-explorer');
				if (leaves.length > 0) {
					const leaf = leaves[0];
					const view = leaf.view as FileExplorerViewLike;
					if (typeof view.getSortedFolderItems === 'function') {
						proto = view;
					}
				}
			}

			// Method 3: skip - not all Workspace versions have getLeaves()

			// Method 4: try common internal plugin paths
			if (!proto) {
				try {
					const explorerView = (this.app as any).fileExplorer?.view;
					if (explorerView && typeof explorerView.getSortedFolderItems === 'function') {
						proto = explorerView;
					}
				} catch { /* ignore */ }
			}

			if (!proto) {
				// Method 5: scan all internal plugins for the prototype
				try {
					const internal = (this.app as any).internalPlugins;
					if (internal?.defs) {
						for (const def of internal.defs) {
							if (def?.type === 'file-explorer' && def?.view) {
								proto = def.view;
								break;
							}
						}
					}
				} catch { /* ignore */ }
			}

			if (!proto) {
				// Last resort: search window for the constructor
				try {
					const w = window as unknown as Record<string, unknown>;
					for (const key of Object.keys(w)) {
						const val = w[key];
						if (val && typeof val === 'function' && (val as any).prototype) {
							const p = (val as any).prototype;
							if (p && typeof p.getSortedFolderItems === 'function') {
								proto = p;
								break;
							}
						}
					}
				} catch { /* ignore */ }
			}

			return proto;
		};

		const viewProto = findAndPatch();

		if (!viewProto) {
			console.warn('[pinned-notes-top] Could not locate FileExplorerView prototype. Retrying in 2s...');
			// Delayed retry
			setTimeout(() => {
				const proto2 = findAndPatch();
				if (!proto2) {
					console.warn('[pinned-notes-top] Still could not locate FileExplorerView after retry.');
					return;
				}
				this.applyPatch(proto2);
			}, 2000);
			return;
		}

		this.applyPatch(viewProto);
	}

	/** Apply the monkey-patch to a FileExplorerView prototype. */
	private applyPatch(proto: FileExplorerViewLike): void {
		const original = proto.getSortedFolderItems;
		if (!original) return;

		const plugin = this;

		proto.getSortedFolderItems = function (this: FileExplorerViewLike, folder: TFolder): FileExplorerItem[] {
			const items = original.call(this, folder);

			// Separate pinned items from the rest.
			const pinnedPaths = plugin.getPinnedInFolder(folder);
			if (pinnedPaths.length === 0) return items;

			const pinned: FileExplorerItem[] = [];
			const unpinned: FileExplorerItem[] = [];

			for (const item of items) {
				const key = plugin._fileKey(item.file);
				if (pinnedPaths.includes(key)) {
					pinned.push(item);
				} else {
					unpinned.push(item);
				}
			}

			// Return pinned first, then the rest (preserving Obsidian's sort).
			return [...pinned, ...unpinned];
		} as ProtoMethod;

		this._uninstallPatch = () => {
			proto.getSortedFolderItems = original;
		};
	}

	private uninstallPatch(): void {
		if (this._uninstallPatch) {
			this._uninstallPatch();
			this._uninstallPatch = null;
		}
	}

	// ── File system event handlers ───────────────────────────────────────────

	private onFileRenamed(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;

		const oldPath = file.path;
		const pinned = this.settings.pinned;

		// Re-key pinned entries under the new path
		for (const folderPath of Object.keys(pinned)) {
			const list = pinned[folderPath];
			const newPinned: string[] = [];

			// If the file is in a subfolder of `folderPath`, update its entry
			for (const entry of list) {
				const parent = this.app.vault.getAbstractFileByPath(entry)?.parent;
				if (parent && parent.path === oldPath) {
					// The pinned item IS a folder that was renamed — not typical,
					// but handle it.
					newPinned.push(file.path);
				} else if (parent && parent.path.startsWith(folderPath)) {
					newPinned.push(entry);
				} else {
					newPinned.push(entry);
				}
			}

			// Simpler approach: just rebuild based on the file's new parent.
			// The key is path-based, so renames naturally update.
			if (list.some((e) => e === oldPath)) {
				newPinned.length = 0;
				for (const entry of list) {
					newPinned.push(entry === oldPath ? file.path : entry);
				}
			}

			if (newPinned.length !== list.length || !newPinned.every((v, i) => v === list[i])) {
				pinned[folderPath] = newPinned;
			}
		}

		this._pinnedStateCache = null;
		this.refreshAllExplorerViews();
	}

	private onFileDeleted(file: TAbstractFile): void {
		if (!(file instanceof TAbstractFile)) return;

		const key = file instanceof TFile ? this._fileKey(file) : file.path;
		const pinned = this.settings.pinned;

		for (const folderPath of Object.keys(pinned)) {
			const list = pinned[folderPath];
			const idx = list.indexOf(key);
			if (idx !== -1) {
				list.splice(idx, 1);
				if (list.length === 0) {
					delete pinned[folderPath];
				}
			}
		}

		this._pinnedStateCache = null;
		this.refreshAllExplorerViews();
	}

	private onFileCreated(file: TAbstractFile): void {
		// No special action needed; new files appear in normal sort order.
		// The user can pin them via command or context menu.
		this._pinnedStateCache = null;
		this.refreshAllExplorerViews();
	}

	// ── UI helpers ───────────────────────────────────────────────────────────

	private handleFileMenu(
		menu: Menu,
		file: TAbstractFile | null,
		source: string,
	): void {
		if (!file) return;

		// Only handle files (not folders) and only in context menus relevant to files.
		if (!(file instanceof TFile) || file.parent === null) return;

		const pinned = this.isFilePinned(file);

		menu.addItem((item) => {
			item
				.setTitle(pinned ? '📍 Unpin from top' : '📌 Pin to top of folder')
				.setIcon(pinned ? 'pin-x' : 'pin')
				.setSection('action')
				.onClick(async () => {
					this.togglePin(!pinned);
				});
		});
	}

	/** Rebuild all file explorer views to reflect new pinning state. */
	private refreshAllExplorerViews(): void {
		const leaves = this.app.workspace.getLeavesOfType('file-explorer');
		for (const leaf of leaves) {
			const view = leaf.view as FileExplorerViewLike;
			if (typeof view.requestSort === 'function') {
				view.requestSort();
			}
		}
	}

	/**
	 * Build a stable key for a file/folder: its vault-relative path.
	 * This is the key used in settings.pinned — matching what getSortedFolderItems
	 * returns as item.file.path.
	 */
	private _fileKey(file: TAbstractFile): string {
		return file.path;
	}

	/** Called from settings to reset cache and refresh views. */
	refresh(): void {
		this._pinnedStateCache = null;
		this.refreshAllExplorerViews();
	}
}

// ─── Settings Tab ────────────────────────────────────────────────────────────

class PinnedNoteSettingTab extends SettingTab {
	plugin: PinnedNotePlugin;

	constructor(plugin: PinnedNotePlugin) {
		super();
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Pinned Notes to Top' });
		containerEl.createEl('p', {
			text: 'Pin notes to the top of their folder in the file explorer. Pinned notes appear above all other items regardless of sort order.',
		});

		// Hotkey bindings info
		containerEl.createEl('h3', { text: 'Commands' });
		const cmds = [
			['Pin to top of folder', 'pin-to-top'],
			['Unpin from top of folder', 'unpin-from-top'],
			['Toggle pin status', 'toggle-pin-status'],
		];
		for (const [name, id] of cmds) {
			containerEl.createEl('p', { text: `• ${name}` });
		}

		// Show currently pinned notes
		containerEl.createEl('h3', { text: 'Currently Pinned Notes' });

		const pinned = this.plugin.settings.pinned;
		const entries = Object.entries(pinned).filter(([, v]) => v.length > 0);

		if (entries.length === 0) {
			containerEl.createEl('p', {
				text: 'No notes are currently pinned.',
				attr: { style: 'color: var(--text-muted);' },
			});
		} else {
			for (const [folderPath, pinnedList] of entries) {
				const folderEl = containerEl.createEl('div', {
					attr: { style: 'margin-bottom: 8px; padding: 8px; background: var(--background-modifier-form-field); border-radius: 4px;' },
				});
				folderEl.createEl('strong', { text: folderPath });

				for (const pinnedPath of pinnedList) {
					const pinnedEl = folderEl.createEl('div', {
						attr: { style: 'padding-left: 12px; color: var(--text-muted);' },
					});
					pinnedEl.createEl('span', { text: '📌 ' });
					pinnedEl.createEl('span', {
						text: pinnedPath,
						attr: { style: 'font-size: 0.9em;' },
					});
				}
			}
		}

		// Clear all pinned notes
		const clearSetting = new Setting(containerEl)
			.setName('Clear all pinned notes')
			.setDesc('Remove all pinning from all folders.')
			.addButton((btn) =>
				btn
					.setButtonText('Clear All')
					.setCta()
					.onClick(async () => {
						this.plugin.settings.pinned = {};
						await this.plugin.saveSettings();
						this.plugin.refresh();
						this.display();
					}),
			);

		// Hotkey configuration info
		containerEl.createEl('h3', { text: 'Hotkeys' });
		containerEl.createEl('p', {
			text: 'You can assign hotkeys to the commands above in Settings → Keyboard Shortcuts.',
		});
	}
}
