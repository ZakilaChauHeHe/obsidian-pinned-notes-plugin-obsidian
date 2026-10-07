import { App, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, Setting, SettingTab, IconName } from 'obsidian';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PinnedNotePluginSettings {
	pinned: Record<string, string[]>; // folder path -> array of file paths pinned to top
	pinnedFolders: Record<string, boolean>; // folder path -> pinned (true)
}

const DEFAULT_SETTINGS: PinnedNotePluginSettings = {
	pinned: {},
	pinnedFolders: {},
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

class PinnedNotePlugin extends Plugin {
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
			this.app.workspace.on('folder-menu', (menu, folder, source) => {
				this.handleFolderMenu(menu, folder, source);
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

		this.addCommand({
			id: 'pin-folder',
			name: 'Pin current folder to top',
			editorCallback: () => {
				const folder = this.app.workspace.getActiveFile()?.parent;
				if (folder) this.toggleFolderPin(folder);
				else new Notice('No folder is currently open.');
			},
		});

		this.addCommand({
			id: 'unpin-folder',
			name: 'Unpin current folder from top',
			editorCallback: () => {
				const folder = this.app.workspace.getActiveFile()?.parent;
				if (folder) this.toggleFolderPin(folder);
				else new Notice('No folder is currently open.');
			},
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

	/** Returns true if the given folder is pinned. */
	isFolderPinned(folder: TAbstractFile | null): boolean {
		if (!folder || !(folder instanceof TFolder)) return false;
		return !!this.settings.pinnedFolders[folder.path];
	}

	/** Returns the full list of pinned file keys for a folder (empty if none). */
	getPinnedInFolder(folder: TFolder): string[] {
		const pinnedList = this.settings.pinned[folder.path] || [];
		// Also include contents of all pinned subfolders of this folder.
		for (const [fp, pinned] of Object.entries(this.settings.pinned)) {
			if (fp.startsWith(folder.path + '/') && fp !== folder.path) {
				// This is a subfolder; its pinned files should appear as if they
				// belong to the parent if we want subfolder pinning.  For now,
				// only include direct child folder pins.
			}
		}
		return pinnedList;
	}

	/** Returns the list of pinned subfolder paths for a folder. */
	getPinnedSubfolders(folder: TFolder): string[] {
		const result: string[] = [];
		for (const fp of Object.keys(this.settings.pinnedFolders)) {
			if (fp.startsWith(folder.path + '/') && fp !== folder.path) {
				result.push(fp);
			}
		}
		return result;
	}

	/** Toggle the pin status for a folder or file. */
	async toggleFolderPin(file: TAbstractFile | null): Promise<void> {
		if (!file) {
			new Notice('No file or folder is selected.');
			return;
		}

		const folder = file.parent;
		if (!folder) {
			new Notice('File or folder has no parent folder — nothing to pin to.');
			return;
		}

		const key = file.path;

		if (file instanceof TFolder) {
			const pinnedFolders = this.settings.pinnedFolders;
			if (pinnedFolders[key]) {
				// Unpin this folder and remove its pinned files from parent.
				delete pinnedFolders[key];
				// Remove files from this folder that are also pinned in the parent.
				const pinnedList = this.settings.pinned[folder.path];
				if (pinnedList) {
					for (const entry of pinnedList) {
						if (entry.startsWith(key + '/')) {
							const idx = pinnedList.indexOf(entry);
							if (idx !== -1) pinnedList.splice(idx, 1);
						}
					}
					if (pinnedList.length === 0) {
						delete this.settings.pinned[folder.path];
					}
				}
				await this.saveSettings();
				new Notice(`Unpinned "${file.name}" from top of ${folder.name}`);
			} else {
				// Pin this folder: add to pinned folders and add its contents to parent's pinned list.
				pinnedFolders[key] = true;
				let pinnedList = this.settings.pinned[folder.path];
				if (!pinnedList) pinnedList = [];
				// Add all files in the subfolder to the parent's pinned list.
				const allFiles = this.getAllFilesInFolder(file);
				for (const f of allFiles) {
					const fkey = f.path;
					if (!pinnedList.includes(fkey)) {
						pinnedList.unshift(fkey);
					}
				}
				this.settings.pinned[folder.path] = pinnedList;
				await this.saveSettings();
				new Notice(`Pinned folder "${file.name}" to top of ${folder.name}`);
			}
		} else {
			new Notice('Only folders can be pinned using this command.');
			return;
		}

		this._pinnedStateCache = null;
		this.refreshAllExplorerViews();
	}

	/** Recursively get all files in a folder. */
	private getAllFilesInFolder(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile) {
				files.push(child);
			} else if (child instanceof TFolder) {
				files.push(...this.getAllFilesInFolder(child));
			}
		}
		return files;
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
			new Notice(`Pinned "${file.basename}" to top of ${folder.name}`);
		} else {
			const idx = pinnedList.indexOf(key);
			if (idx !== -1) {
				pinnedList.splice(idx, 1);
				this.settings.pinned[folder.path] = pinnedList;
				await this.saveSettings();
				new Notice(`Unpinned "${file.basename}" from ${folder.name}`);
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
			const pinnedPaths = plugin.getPinnedInFolder(folder);

			// Remove all pin indicators from all items first.
			for (const item of items) {
				plugin.removePinIndicator(item.selfEl);
			}

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

			// Add pin indicator icons to pinned items.
			for (const item of pinned) {
				plugin.addPinIndicator(item.selfEl);
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
		if (!(file instanceof TAbstractFile)) return;

		const oldPath = file instanceof TFile ? file.path : file.path;

		// Update pinned file entries whose path was renamed.
		for (const folderPath of Object.keys(this.settings.pinned)) {
			const list = this.settings.pinned[folderPath];
			const updated: string[] = [];
			let changed = false;

			for (const entry of list) {
				if (entry === oldPath) {
					updated.push(file.path);
					changed = true;
				} else if (entry.startsWith(oldPath + '/')) {
					updated.push(file.path + entry.slice(oldPath.length));
					changed = true;
				} else {
					updated.push(entry);
				}
			}

			if (changed) {
				this.settings.pinned[folderPath] = updated;
			}
		}

		// Update pinned folder entries.
		for (const folderPath of Object.keys(this.settings.pinnedFolders)) {
			if (folderPath === oldPath) {
				this.settings.pinnedFolders[file.path] = true;
				delete this.settings.pinnedFolders[folderPath];
			} else if (folderPath.startsWith(oldPath + '/')) {
				this.settings.pinnedFolders[file.path + folderPath.slice(oldPath.length)] = true;
				delete this.settings.pinnedFolders[folderPath];
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
				.setTitle(pinned ? 'Unpin from top' : 'Pin to top of folder')
				.setIcon(pinned ? 'pin-x' : 'pin')
				.setSection('action')
				.onClick(async () => {
					this.togglePin(!pinned);
				});
		});
	}

	private handleFolderMenu(
		menu: Menu,
		folder: TFolder,
		source: string,
	): void {
		const pinned = this.isFolderPinned(folder);

		menu.addItem((item) => {
			item
				.setTitle(pinned ? 'Unpin folder from top' : 'Pin folder to top')
				.setIcon(pinned ? 'pin-x' : 'folder')
				.setSection('action')
				.onClick(async () => {
					this.toggleFolderPin(folder);
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

	/** Add a pin indicator icon next to a file in the file explorer. */
	private addPinIndicator(el: HTMLElement): void {
		if (el.querySelector('.pin-indicator')) return;
		const titleEl = el.querySelector('.nav-file-title');
		if (!titleEl) return;
		const icon = titleEl.createEl('span', { cls: 'pin-indicator' });
		icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1h1.43a1 1 0 0 1 .7.28l.64.64a1 1 0 0 0 .7.28H21"></path></svg>';
		icon.setAttribute('aria-label', 'Pinned');
		icon.style.marginRight = '4px';
		icon.style.verticalAlign = 'middle';
		titleEl.prepend(icon);
	}

	/** Remove a pin indicator icon from a file in the file explorer. */
	private removePinIndicator(el: HTMLElement): void {
		const icon = el.querySelector('.pin-indicator');
		if (icon) {
			icon.remove();
		}
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
			['Pin current folder to top', 'pin-folder'],
			['Unpin current folder from top', 'unpin-folder'],
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
					const pinIcon = pinnedEl.createEl('span', { cls: 'pin-indicator-settings' });
					pinIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1h1.43a1 1 0 0 1 .7.28l.64.64a1 1 0 0 0 .7.28H21"></path></svg>';
					pinIcon.style.marginRight = '4px';
					pinIcon.style.verticalAlign = 'middle';
					pinnedEl.createEl('span', {
						text: pinnedPath,
						attr: { style: 'font-size: 0.9em;' },
					});
				}
			}
		}

		// Show currently pinned folders
		containerEl.createEl('h3', { text: 'Currently Pinned Folders' });

		const pinnedFolders = this.plugin.settings.pinnedFolders;
		const folderEntries = Object.keys(pinnedFolders).filter((k) => pinnedFolders[k]);

		if (folderEntries.length === 0) {
			containerEl.createEl('p', {
				text: 'No folders are currently pinned.',
				attr: { style: 'color: var(--text-muted);' },
			});
		} else {
			for (const folderPath of folderEntries) {
				const folderEl = containerEl.createEl('div', {
					attr: { style: 'margin-bottom: 6px; padding: 6px 8px; background: var(--background-modifier-form-field); border-radius: 4px;' },
				});
				const pinIcon = folderEl.createEl('span', { cls: 'pin-indicator-settings' });
				pinIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1h1.43a1 1 0 0 1 .7.28l.64.64a1 1 0 0 0 .7.28H21"></path></svg>';
				pinIcon.style.marginRight = '4px';
				pinIcon.style.verticalAlign = 'middle';
				folderEl.createEl('span', {
					text: folderPath,
					attr: { style: 'font-size: 0.9em;' },
				});
			}
		}

		// Clear all pinned notes and folders
		const clearSetting = new Setting(containerEl)
			.setName('Clear all pinned notes')
			.setDesc('Remove all pinning from all folders.')
			.addButton((btn) =>
				btn
					.setButtonText('Clear All')
					.setCta()
					.onClick(async () => {
						this.plugin.settings.pinned = {};
						this.plugin.settings.pinnedFolders = {};
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

// ─── Obsidian requires module.exports for plugin loading ──────────────────────
// This ensures the built JS has a plain CommonJS export, not just ESM helpers.
module.exports = PinnedNotePlugin;
