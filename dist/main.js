var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => PinnedNotePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  pinned: {}
};
var PinnedNotePlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this._uninstallPatch = null;
    // Whether the current file in the active leaf is pinned in its folder.
    this._pinnedStateCache = null;
  }
  // ── Lifecycle ────────────────────────────────────────────────────────────
  onload() {
    return __async(this, null, function* () {
      yield this.loadSettings();
      this.registerEvent(
        this.app.workspace.on("file-menu", (menu, file, source) => {
          this.handleFileMenu(menu, file, source);
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, _oldPath) => {
          this.onFileRenamed(file);
        })
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          this.onFileDeleted(file);
        })
      );
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          this.onFileCreated(file);
        })
      );
      this.addCommand({
        id: "pin-to-top",
        name: "Pin to top of folder",
        editorCallback: () => this.togglePin(true)
      });
      this.addCommand({
        id: "unpin-from-top",
        name: "Unpin from top of folder",
        editorCallback: () => this.togglePin(false)
      });
      this.addCommand({
        id: "toggle-pin-status",
        name: "Toggle pin status",
        editorCallback: () => {
          const pinned = this.isFilePinned(this.app.workspace.getActiveFile());
          this.togglePin(pinned ? false : true);
        }
      });
      this.addRibbonIcon("pin", "Pin current note", () => {
        const file = this.app.workspace.getActiveFile();
        if (!file)
          return;
        this.togglePin(true);
      });
      this.addSettingTab(new PinnedNoteSettingTab(this));
      this.patchExplorerPrototype();
      this.registerInterval(
        window.setInterval(() => {
          this._pinnedStateCache = null;
          this.refreshAllExplorerViews();
        }, 5e3)
      );
      this.app.workspace.onLayoutReady(() => {
        this.refreshAllExplorerViews();
      });
    });
  }
  onunload() {
    return __async(this, null, function* () {
      this.uninstallPatch();
      this._pinnedStateCache = null;
    });
  }
  // ── Settings persistence ─────────────────────────────────────────────────
  loadSettings() {
    return __async(this, null, function* () {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, yield this.loadData());
    });
  }
  saveSettings() {
    return __async(this, null, function* () {
      yield this.saveData(this.settings);
    });
  }
  // ── Core logic ───────────────────────────────────────────────────────────
  /** Returns true if the given file is pinned in its parent folder. */
  isFilePinned(file) {
    if (!file || !(file instanceof import_obsidian.TFile))
      return false;
    const folder = file.parent;
    if (!folder)
      return false;
    const key = this._fileKey(file);
    const cached = this._pinnedStateCache;
    if (cached && cached.path === key)
      return cached.pinned;
    const pinnedList = this.settings.pinned[folder.path];
    const pinned = pinnedList ? pinnedList.includes(key) : false;
    this._pinnedStateCache = { path: key, pinned };
    return pinned;
  }
  /** Returns the full list of pinned file keys for a folder (empty if none). */
  getPinnedInFolder(folder) {
    const pinnedList = this.settings.pinned[folder.path];
    return pinnedList ? [...pinnedList] : [];
  }
  /** Toggle the pin status for a file in its folder. */
  togglePin(pin) {
    return __async(this, null, function* () {
      const file = this.app.workspace.getActiveFile();
      if (!file) {
        new import_obsidian.Notice("No file is currently open.");
        return;
      }
      const folder = file.parent;
      if (!folder) {
        new import_obsidian.Notice("File has no parent folder \u2014 nothing to pin to.");
        return;
      }
      const key = this._fileKey(file);
      let pinnedList = this.settings.pinned[folder.path];
      if (!pinnedList)
        pinnedList = [];
      if (pin) {
        if (!pinnedList.includes(key)) {
          pinnedList.unshift(key);
        }
        this.settings.pinned[folder.path] = pinnedList;
        yield this.saveSettings();
        new import_obsidian.Notice(`\u{1F4CC} Pinned "${file.basename}" to top of ${folder.name}`);
      } else {
        const idx = pinnedList.indexOf(key);
        if (idx !== -1) {
          pinnedList.splice(idx, 1);
          this.settings.pinned[folder.path] = pinnedList;
          yield this.saveSettings();
          new import_obsidian.Notice(`\u{1F4CD} Unpinned "${file.basename}" from ${folder.name}`);
        } else {
          new import_obsidian.Notice(`"${file.basename}" is not currently pinned.`);
        }
      }
      this._pinnedStateCache = null;
      this.refreshAllExplorerViews();
    });
  }
  // ── Explorer prototype patching ──────────────────────────────────────────
  /**
   * Monkey-patch `getSortedFolderItems` on the FileExplorerView prototype.
   * Returns pinned items first, then the rest in Obsidian's default order.
   */
  patchExplorerPrototype() {
    const findAndPatch = () => {
      var _a, _b, _c;
      let proto = null;
      try {
        const plugins = (_a = this.app.internalPlugins) == null ? void 0 : _a.plugins;
        if (Array.isArray(plugins)) {
          for (const p of plugins) {
            if (p == null ? void 0 : p.view) {
              const v = p.view;
              if (v && typeof v.getSortedFolderItems === "function") {
                proto = v;
                break;
              }
            }
            if (((_b = p == null ? void 0 : p.constructor) == null ? void 0 : _b.prototype) && typeof p.constructor.prototype.getSortedFolderItems === "function") {
              proto = p.constructor.prototype;
              break;
            }
          }
        }
      } catch (e) {
      }
      if (!proto) {
        const leaves = this.app.workspace.getLeavesOfType("file-explorer");
        if (leaves.length > 0) {
          const leaf = leaves[0];
          const view = leaf.view;
          if (typeof view.getSortedFolderItems === "function") {
            proto = view;
          }
        }
      }
      if (!proto) {
        try {
          const explorerView = (_c = this.app.fileExplorer) == null ? void 0 : _c.view;
          if (explorerView && typeof explorerView.getSortedFolderItems === "function") {
            proto = explorerView;
          }
        } catch (e) {
        }
      }
      if (!proto) {
        try {
          const internal = this.app.internalPlugins;
          if (internal == null ? void 0 : internal.defs) {
            for (const def of internal.defs) {
              if ((def == null ? void 0 : def.type) === "file-explorer" && (def == null ? void 0 : def.view)) {
                proto = def.view;
                break;
              }
            }
          }
        } catch (e) {
        }
      }
      if (!proto) {
        try {
          const w = window;
          for (const key of Object.keys(w)) {
            const val = w[key];
            if (val && typeof val === "function" && val.prototype) {
              const p = val.prototype;
              if (p && typeof p.getSortedFolderItems === "function") {
                proto = p;
                break;
              }
            }
          }
        } catch (e) {
        }
      }
      return proto;
    };
    const viewProto = findAndPatch();
    if (!viewProto) {
      console.warn("[pinned-notes-top] Could not locate FileExplorerView prototype. Retrying in 2s...");
      setTimeout(() => {
        const proto2 = findAndPatch();
        if (!proto2) {
          console.warn("[pinned-notes-top] Still could not locate FileExplorerView after retry.");
          return;
        }
        this.applyPatch(proto2);
      }, 2e3);
      return;
    }
    this.applyPatch(viewProto);
  }
  /** Apply the monkey-patch to a FileExplorerView prototype. */
  applyPatch(proto) {
    const original = proto.getSortedFolderItems;
    if (!original)
      return;
    const plugin = this;
    proto.getSortedFolderItems = function(folder) {
      const items = original.call(this, folder);
      const pinnedPaths = plugin.getPinnedInFolder(folder);
      if (pinnedPaths.length === 0)
        return items;
      const pinned = [];
      const unpinned = [];
      for (const item of items) {
        const key = plugin._fileKey(item.file);
        if (pinnedPaths.includes(key)) {
          pinned.push(item);
        } else {
          unpinned.push(item);
        }
      }
      return [...pinned, ...unpinned];
    };
    this._uninstallPatch = () => {
      proto.getSortedFolderItems = original;
    };
  }
  uninstallPatch() {
    if (this._uninstallPatch) {
      this._uninstallPatch();
      this._uninstallPatch = null;
    }
  }
  // ── File system event handlers ───────────────────────────────────────────
  onFileRenamed(file) {
    var _a;
    if (!(file instanceof import_obsidian.TFile))
      return;
    const oldPath = file.path;
    const pinned = this.settings.pinned;
    for (const folderPath of Object.keys(pinned)) {
      const list = pinned[folderPath];
      const newPinned = [];
      for (const entry of list) {
        const parent = (_a = this.app.vault.getAbstractFileByPath(entry)) == null ? void 0 : _a.parent;
        if (parent && parent.path === oldPath) {
          newPinned.push(file.path);
        } else if (parent && parent.path.startsWith(folderPath)) {
          newPinned.push(entry);
        } else {
          newPinned.push(entry);
        }
      }
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
  onFileDeleted(file) {
    if (!(file instanceof import_obsidian.TAbstractFile))
      return;
    const key = file instanceof import_obsidian.TFile ? this._fileKey(file) : file.path;
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
  onFileCreated(file) {
    this._pinnedStateCache = null;
    this.refreshAllExplorerViews();
  }
  // ── UI helpers ───────────────────────────────────────────────────────────
  handleFileMenu(menu, file, source) {
    if (!file)
      return;
    if (!(file instanceof import_obsidian.TFile) || file.parent === null)
      return;
    const pinned = this.isFilePinned(file);
    menu.addItem((item) => {
      item.setTitle(pinned ? "\u{1F4CD} Unpin from top" : "\u{1F4CC} Pin to top of folder").setIcon(pinned ? "pin-x" : "pin").setSection("action").onClick(() => __async(this, null, function* () {
        this.togglePin(!pinned);
      }));
    });
  }
  /** Rebuild all file explorer views to reflect new pinning state. */
  refreshAllExplorerViews() {
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of leaves) {
      const view = leaf.view;
      if (typeof view.requestSort === "function") {
        view.requestSort();
      }
    }
  }
  /**
   * Build a stable key for a file/folder: its vault-relative path.
   * This is the key used in settings.pinned — matching what getSortedFolderItems
   * returns as item.file.path.
   */
  _fileKey(file) {
    return file.path;
  }
  /** Called from settings to reset cache and refresh views. */
  refresh() {
    this._pinnedStateCache = null;
    this.refreshAllExplorerViews();
  }
};
var PinnedNoteSettingTab = class extends import_obsidian.SettingTab {
  constructor(plugin) {
    super();
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Pinned Notes to Top" });
    containerEl.createEl("p", {
      text: "Pin notes to the top of their folder in the file explorer. Pinned notes appear above all other items regardless of sort order."
    });
    containerEl.createEl("h3", { text: "Commands" });
    const cmds = [
      ["Pin to top of folder", "pin-to-top"],
      ["Unpin from top of folder", "unpin-from-top"],
      ["Toggle pin status", "toggle-pin-status"]
    ];
    for (const [name, id] of cmds) {
      containerEl.createEl("p", { text: `\u2022 ${name}` });
    }
    containerEl.createEl("h3", { text: "Currently Pinned Notes" });
    const pinned = this.plugin.settings.pinned;
    const entries = Object.entries(pinned).filter(([, v]) => v.length > 0);
    if (entries.length === 0) {
      containerEl.createEl("p", {
        text: "No notes are currently pinned.",
        attr: { style: "color: var(--text-muted);" }
      });
    } else {
      for (const [folderPath, pinnedList] of entries) {
        const folderEl = containerEl.createEl("div", {
          attr: { style: "margin-bottom: 8px; padding: 8px; background: var(--background-modifier-form-field); border-radius: 4px;" }
        });
        folderEl.createEl("strong", { text: folderPath });
        for (const pinnedPath of pinnedList) {
          const pinnedEl = folderEl.createEl("div", {
            attr: { style: "padding-left: 12px; color: var(--text-muted);" }
          });
          pinnedEl.createEl("span", { text: "\u{1F4CC} " });
          pinnedEl.createEl("span", {
            text: pinnedPath,
            attr: { style: "font-size: 0.9em;" }
          });
        }
      }
    }
    const clearSetting = new import_obsidian.Setting(containerEl).setName("Clear all pinned notes").setDesc("Remove all pinning from all folders.").addButton(
      (btn) => btn.setButtonText("Clear All").setCta().onClick(() => __async(this, null, function* () {
        this.plugin.settings.pinned = {};
        yield this.plugin.saveSettings();
        this.plugin.refresh();
        this.display();
      }))
    );
    containerEl.createEl("h3", { text: "Hotkeys" });
    containerEl.createEl("p", {
      text: "You can assign hotkeys to the commands above in Settings \u2192 Keyboard Shortcuts."
    });
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {});
