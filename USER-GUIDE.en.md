# QuillPad 1.0.3 User Guide

> English · for v1.0.3 · MIT licensed · repository <https://github.com/Frank-TCA/quillpad-desktop>

The installers live in `dist/release/` (you can copy them anywhere):

| File | Purpose | Size |
| --- | --- | --- |
| `QuillPad-Setup-v1.0.3.exe` | Installer | ~127 MB |
| `QuillPad-v1.0.3-portable.exe` | Portable | ~115 MB |
| `QuillPad-Uninstaller-v1.0.3.exe` | Standalone uninstaller (installer build only) | ~80 KB |

> Exact byte counts and SHA256 checksums are listed on the corresponding release page.

QuillPad is open source under the MIT license: <https://github.com/Frank-TCA/quillpad-desktop>

## 1. Feature overview

### New files and tabs

- Creating a file asks two things first — a name and a type: `Ctrl+N` (or **New** on the toolbar, or the **+** at the end of the tab bar) opens a dialog where you type a name and pick one of 40 types (`.txt` / `.md` / `.json` / `.js` / `.py` …). The type list shares its source with the language table, so anything you can pick is highlighted.
- Name and type follow each other in both directions: typing `README.md` moves the dropdown to Markdown; changing the type renames `Untitled.txt` to `Untitled.md`. Enter creates the file, `Esc` cancels.
- The **+** button sits to the right of the last tab and does the same as `Ctrl+N`; when tabs overflow it sticks to the right edge instead of being scrolled out of view.
- If you would rather skip the dialog, use **New Blank File (No Type Prompt)** in the command palette (`Ctrl+Shift+P`).

### Typesetting and writing

- Three view modes — source / WYSIWYG / split — switch directly with `Ctrl+Shift+1` / `2` / `3`. Source mode is a code editor with a fixed 14 px monospace face; WYSIWYG and the split preview are reading surfaces with a 16 px / 28 px line-height / 736 px (46 em) width sans-serif body. **WYSIWYG shows no line-number column and no fold arrows** (a reading surface does not need them); switch to source or split when you want them.
- WYSIWYG renders headings, bold and italic, strikethrough, inline code, links, quotes, lists, task items, code blocks, tables, images, math (KaTeX), footnotes, and a table of contents in place; source markers appear on the line your cursor is on. A single click selects a whole table block, a double click enters cell editing.
- Table parsing/serialization, adding and removing rows and columns, cycling column alignment, `Tab` to move between cells; drag or paste an image and it lands in an `assets\` folder next to the document, with a random suffix when the name is taken — existing files are never overwritten.
- Macro recording, playback, and persistence (a red breathing dot appears in the **bottom-right** of the status bar while recording; click it to stop and name the macro); rectangular (column) selection with insert, delete, align, and number; a searchable panel of ~840 special characters in 10 categories (plus the last 20 you used); find history (up to 20 entries — press `↓` in an empty search box to recall the most recent one).
- Design tokens (`--qp-*` variables) with four themes; **Reduce Motion** is supported.

### Printing and PDF

- Self-contained print pages: fonts inlined as `data:`, images inlined or replaced by placeholders, no external links, no scripts.
- The export dialog is a single column of settings (12 rows are visible by default; choosing a custom page size adds a size row, and a custom header or footer adds a text row) with no thumbnail preview. A real subset of Noto Sans SC is embedded, so CJK text in the PDF is an embedded subset rather than a reference to a system font.
- Page numbers come back through Chromium's footer template; the table of contents is a chapter list without page numbers.

### Plugin ecosystem

- Everything lives in the **Plugin Manager** dialog (search the command palette for the marketplace, or right-click the menu bar → **Plugin Manager…**): the top half is the installed list (enable / disable / uninstall, with four-state labels: enabled / disabled / crashed / blocked — non-compliant license), the bottom half is the marketplace (search, categories, sorting, license badges, install). Installing first shows the permission list for confirmation, and `network` / `files:write` are high-risk permissions that need a second confirmation.
- Three official MIT packages: `quillpad.text-tools` (13 commands), `quillpad.md-tools` (4 commands), and `quillpad.dev-tools` (4 commands + 1 plugin view) — 21 commands and 1 view in total (views are listed as cards at the bottom of the Plugin Manager dialog). Disabling a package really unregisters its commands; re-enabling restores them.
- Four more community packages: JSON formatter (2 commands), JSON Schema lookup (1 command), CSV to JSON (1 command), and enhanced line sorting (4 commands). They install from a zip after a `sha256` check. The marketplace lists 7 entries (3 official + 4 community) and every one of them was verified to install; packages that cannot install never appear in the list.
- Plugins run inside a module Worker sandbox and are authorized one call at a time by the main thread; if a 5-second heartbeat goes unanswered the Worker is terminated and the plugin disabled (it does not come back on restart).
- The **Import Plugins from Notepad++** wizard scans the local plugin directories and reports 40 compatibility mappings in three buckets: built in, one-click install, and unsupported.

### Compliance

- `THIRD-PARTY-NOTICES.txt` and the Noto fonts' `OFL.txt` ship with **both** package types under `<install dir or portable unpack dir>\resources\licenses\`; there is also a copy of `THIRD-PARTY-NOTICES.txt` in the repository root. There are 27 runtime dependencies and none is GPL / AGPL / SSPL.

## 2. Using the installer build (recommended)

1. Double-click `QuillPad-Setup-v1.0.3.exe`.
2. On first run Windows may show “Windows protected your PC”. Every new program without a code-signing certificate gets this prompt; it does not mean the file is infected. Click **More info** → **Run anyway**.
3. **The installer's own UI is Chinese** — only `zh_CN` is bundled (`installerLanguages: zh_CN`, language id 2052). You can still pick the installation directory on the page with the path field. `perMachine=false`, so it installs into your user profile: no administrator rights and no UAC prompt. You can tick “run now” at the end.
4. Start menu and desktop shortcuts are created; the uninstaller `Uninstall QuillPad.exe` lives in the installation directory rather than being left behind in your downloads folder.
5. Press `Win+R` and type `QuillPad` to launch it directly (App Paths is registered).

### Context menu / file associations

Installation registers the `QuillPad.TextFile` ProgID, App Paths, `OpenWithProgids` for 50 text and code extensions, and an **Open with QuillPad** entry in the context menu of every file.

**File associations are a page in the installer** (the step after choosing the install directory): four groups, all ticked by default.

| Group | Extensions |
| --- | --- |
| Markdown documents | `.md`, `.markdown` |
| Plain text & logs | `.txt`, `.log` |
| Source code (31) | `.js` `.mjs` `.cjs` `.jsx` `.ts` `.tsx` `.html` `.htm` `.css` `.scss` `.less` `.vue` `.py` `.java` `.c` `.h` `.cpp` `.hpp` `.cs` `.go` `.rs` `.php` `.rb` `.lua` `.sh` `.bash` `.zsh` `.bat` `.cmd` `.ps1` `.sql` |
| Config & data (15) | `.json` `.jsonc` `.xml` `.svg` `.yml` `.yaml` `.toml` `.ini` `.cfg` `.conf` `.properties` `.env` `.csv` `.tex` `.rst` |

Ticked groups become the **actual default** — double-clicking such a file opens QuillPad. Two writes are needed: `HKCU\Software\Classes\.ext` gets `QuillPad.TextFile` as its default value, and Windows' `UserChoice` record is deleted. Since Windows 8 `UserChoice` wins over that default value, is hash-protected, cannot be rewritten by any program and can only be removed as a whole — that is what lets the system fall back to the default value. So **a default you picked manually will be overridden for the groups you tick**; untick anything you want to keep.

Unticked groups are only registered as candidates in **Open with** and never touch the current default.

You can change it later without reinstalling: **menu → File → File Associations…**. The dialog is filled from the registry's real state (all default / some / none), and **Apply** only writes the groups that actually differ. Its **Open Windows Default Apps…** button jumps to the system page, where **Settings → Apps → Default apps → QuillPad** also lets you flip individual types.

For unattended deployment that must not touch default associations: `QuillPad-Setup-v1.0.3.exe /S /NOASSOC`.

All of these entries live under `HKCU`, need no administrator rights, and are unregistered on uninstall — including the default associations, the capability registration (`Software\QuillPad\Capabilities` plus `RegisteredApplications`), the ProgID and the context menu. **Only entries pointing at QuillPad are removed**; a type you later reassigned to another program is left alone.

Right-click any file → **Open with QuillPad** works too. Selecting several files opens only the first one (a Windows limitation for custom verbs).

## 3. Using the portable build

1. Put `QuillPad-v1.0.3-portable.exe` by itself in an empty folder (a USB stick works) and double-click it. It is a single-file self-extracting package: nothing to install, no registry writes, no shortcuts.
2. Startup takes 3–5 seconds because the single-file build unpacks itself into the system temp directory each time.
3. All user data (session, theme, recent files, window position, macros, plugins and their state, caches) is written to a `QuillPad-Data\` folder **next to the exe**. Measured: after a run that folder holds 81 files including `window-state.json`, and `%APPDATA%\QuillPad` gains nothing while the portable build runs.
4. To move to another machine, copy the exe together with `QuillPad-Data\` and all your settings come along.
5. The portable build writes no registry entries, so it starts with no context menu and no file associations; drag a file onto the window or use **Open File** and you can still save straight back to the original file.
6. Need associations anyway? **Menu → File → File Associations…** registers them against the portable exe itself (not the temp copy it unpacks to). When moving on, delete the exe and `QuillPad-Data\`, then restore the defaults in Windows' Default apps page.

## 4. Four ways to uninstall, plus the standalone uninstaller

1. Start menu → the **卸载 QuillPad** shortcut;
2. `Uninstall QuillPad.exe` in the installation directory;
3. Windows **Settings → Apps → Installed apps** (or **Programs and Features** in Control Panel) → select **QuillPad 文本编辑器** → Uninstall;
4. Double-click the distributed `QuillPad-Uninstaller-v1.0.3.exe` (the standalone uninstaller, about 78 KB).

All four run the same cleanup logic and behave identically — pick whichever is convenient.

The fourth one is a small tool with its own scavenger that depends on nothing in the installation directory:

- **What it scans**: the registry's Uninstall subtree (`HKCU` / `HKLM`, both the 64-bit and 32-bit views, matched fuzzily on the display name — a GUID key name makes no difference), the usual installation directories, user data and caches, start menu / desktop / taskbar shortcuts, file associations, and the context menu;
- it first lists how many directories, files, and registry entries it found, and only acts after you confirm;
- it requests elevation (UAC) automatically when QuillPad lives under `Program Files`, and stays quiet for per-user installs;
- anything it cannot delete (in use or not permitted) is registered for cleanup after a reboot, and it finally reports how many items succeeded and failed;
- the whole run is logged to `%TEMP%\QuillPad-Uninstall.log` (UTF-16, opens in Notepad directly);
- if QuillPad is not on the machine at all it just reports that no traces were found and deletes nothing.

Command line (for scripts and batch files):

```bat
QuillPad-Uninstaller-v1.0.3.exe /S          silent uninstall, no dialogs
QuillPad-Uninstaller-v1.0.3.exe /SCAN /S    scan only, delete nothing
```

Exit codes: `0` = clean, `1` = traces found, `2` = some items could not be deleted, `3` = cancelled by the user.

## 5. Trace cleanup — installer vs portable (important)

### Installer build

All four uninstall entry points run the same trace manifest (`build\traces.nsh`, shared by install and uninstall):

- **Program directories**: `%ProgramFiles%\QuillPad`, `%ProgramFiles(x86)%\QuillPad`, `%LOCALAPPDATA%\Programs\QuillPad`, plus any custom location recorded in the registry (an older version installed to `D:\Apps\QuillPad` is cleaned up too);
- **User data**: `%APPDATA%\QuillPad` (tab session, theme, font size, recent files, window position, macros in `macros.json`, plugins and their state, IndexedDB file handles, caches at every level), `%LOCALAPPDATA%\QuillPad`, `%LOCALAPPDATA%\quillpad-updater`, `%LOCALAPPDATA%\Temp\QuillPad`, `%LOCALAPPDATA%\CrashDumps\QuillPad.exe.*.dmp`;
- **Shortcuts**: start menu (including `卸载 QuillPad.lnk`), desktop, quick launch, and taskbar pins — both the current-user and all-users scopes;
- **Registry**: every QuillPad uninstall entry (whatever the version, whether the key name is a GUID or a name), the `QuillPad.TextFile` ProgID, `Applications\QuillPad.exe`, the `*\shell\QuillPad` context menu, `OpenWithProgids` / `OpenWithList` slots for each extension, App Paths, Run entries, and the MuiCache and association Toast values in Explorer's cache;
- if QuillPad is the default program for an extension, that `UserChoice` is revoked (back to “no default program”) rather than left pointing at a deleted program;
- finally Explorer is told to refresh association icons.

Deleting only the installation directory leaves dead entries in the context menu and **Open with**, so always use one of the uninstall entry points. For icons you pinned to the taskbar manually, the uninstaller deletes the corresponding pin file; if Windows still shows it, right-click → **Unpin from taskbar**.

### Portable build

No registry writes and no shortcuts, so **no uninstaller is needed**: delete `QuillPad-v1.0.3-portable.exe` and the `QuillPad-Data\` folder next to it. Measured: afterwards only the exe remains in its folder, `%APPDATA%\QuillPad` has gained nothing, and no user data is left on the system.

### The one-line difference

The installer build cleans program directory, registry, and user data (including historical versions) through its uninstaller; the portable build is removed by deleting the exe and the `QuillPad-Data` folder. The two are not interchangeable. Installer data lives in `%APPDATA%\QuillPad`, portable data in `QuillPad-Data\` next to the exe, so the two can coexist without affecting each other.

## 6. Marketplace and the Notepad++ boundary

Where to find it: search the command palette for the marketplace (`plugins.market`), or right-click the menu bar → **Plugin Manager…** — the marketplace is the lower half of that dialog (the old sidebar plugin page was merged into it); the **Import Plugins from Notepad++** command scans `%ProgramFiles%\Notepad++\plugins`, `%ProgramFiles(x86)%\Notepad++\plugins`, and `%APPDATA%\Notepad++\plugins`, showing an empty state instead of an error when a directory does not exist.

The following five statements are QuillPad's official statement of scope, worded identically in the marketplace banner, on the last page of the import wizard, and in the `.dll` rejection dialog:

1. QuillPad loads no `.dll` whatsoever and is not a binary-compatible Notepad++ host.
2. Plugins that depend on native Scintilla handles (`_scintillaMainHandle`), `NPPM_*` host messages, docking dialogs, lexer interfaces, or system-level injection are not supported — QuillPad's editor is CodeMirror 6 in the DOM and has no HWND.
3. Distributing or sideloading GPL / AGPL / SSPL plugins is not supported; Notepad++ itself is GPL-2.0 and most of its official plugin library is GPL, so those cannot legally ship with QuillPad.
4. What is offered is capability equivalence, not implementation equivalence: the high-frequency subset of popular Notepad++ plugins is reimplemented natively in the official MIT packages, and no guarantee is made that third-party plugin behavior, configuration format, or shortcuts match one to one.
5. Obtaining and installing GPL plugins from third-party channels is the user's own action; QuillPad does not load them, does not manage them, and accepts no compliance responsibility for them, but it does warn clearly in the installation entry point.

Consequently: dropping a `.dll` into the marketplace is rejected with the reasons above. Of the 40 compatibility mappings, 12 are **built in**, 12 are **ported** (7 of which install with one click in this release, the rest showing “port in progress”), and 16 are **unsupported**. Plugin installation only accepts licenses on the MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC / 0BSD whitelist and must pass schema, static scanning, `sha256`, and path-traversal checks; the `network` and `files:write` permissions are high-risk and require a second confirmation.

## 7. Exporting a PDF

1. Open a Markdown document and use **File → Export as PDF…** (or search the command palette for **Export as PDF** / `pdf.export`) to open the dialog; **Print…** goes through the system print dialog.
2. The dialog is a single column of settings in four groups:
   - **Page**: page size (**A4 / Letter / Custom**; choosing Custom reveals width × height inputs in millimetres, each 50–2000), orientation (Portrait / Landscape), margins (top / bottom / left / right, 0–50 mm);
   - **Appearance**: theme (Follow Current / Light / Dark), code theme (Follow Theme / GitHub Light / One Dark / Solarized), max image width (25% / 50% / 75% / 100%);
   - **Decorations**: page number (Off / Footer Center / Footer Right), table of contents (a chapter list generated from H1–H3), header (None / File Name / Custom), footer (None / File Name + Date / Custom) — choosing Custom reveals a text field limited to 60 characters;
   - **Output**: file name and save location (click **Browse…** to pick a folder; the document's own folder is the default).
3. Clicking **Export** writes straight to the path set in the dialog — no second save dialog. While exporting the button becomes a progress bar and can be cancelled (cancelling leaves no partial file behind). The main process renders with a hidden `BrowserWindow` and `printToPDF`, inlining a subset of the CJK fonts into the print page, so the resulting PDF is self-contained and readable offline.
4. In a plain browser (not Electron) PDF export and printing are unavailable: page numbers, table of contents, header, and footer and their text fields are greyed out with a hint to choose “Save as PDF” in the print dialog. Use the installer or portable build to export PDFs.

Known limitations: the table of contents carries no page numbers; extra-long code blocks (over 40 lines) are soft-wrapped to avoid being cut across pages; the font subset's internal name in the PDF is `NotoSansSC-Thin` although the actual glyphs are Regular 400.

## 8. Open-source licensing

- `THIRD-PARTY-NOTICES.txt`: license inventory for the 27 runtime dependencies, the desktop shell, and the bundled fonts.
- `OFL.txt`: full SIL Open Font License 1.1 text for the Noto Sans SC / Noto Serif SC subsets, plus notes on how the subsets were generated.
- In the source tree these live at `build\THIRD-PARTY-NOTICES.txt` and `src\assets\fonts\OFL.txt`, and they ship with the installer and portable builds under `<install dir or portable unpack dir>\resources\licenses\`; there is also a copy of `THIRD-PARTY-NOTICES.txt` in the repository root.
- **Help → About QuillPad** shows the version and license information in the app.
- Developers can regenerate the inventory with `npm run notices` and verify that no GPL / AGPL / SSPL dependency is present with `npm run license:check`.

## 9. Common shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` | New (with type) / Open / Save / Save As |
| `Ctrl+W` | Close the current tab |
| `Ctrl+F` / `Ctrl+H` / `Ctrl+Shift+F` | Find / Replace / Find in files |
| `Ctrl+Shift+P` | Command palette (every feature is in there — use it when you forget a shortcut) |
| `Ctrl+G` | Go to line |
| `Ctrl+/` | Toggle comment |
| `Ctrl+D` | Duplicate the current line |
| `Alt+↑` / `Alt+↓` | Move the current line up / down |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Increase / decrease / reset font size |
| `Alt+Z` | Word wrap |
| `Ctrl+Shift+1` / `2` / `3` | Source / WYSIWYG / split, directly |
| `F1` | Keyboard shortcut reference |
| `F12` | Developer tools (rarely needed) |

Font size ranges from 14 to 300 px: `Ctrl+=` / `Ctrl+-` step it up and down, and `Ctrl+wheel` works too. Line numbers stay at a fixed 14 px and do not scale with the body text (at a 300 px body they are still 14 px).

### Plugin command shortcuts

Plugin commands are triggered from the keyboard exactly like built-in ones. Key bindings are declared by each package in `contributes.commands[].key` inside its `plugin.json`; they only exist while the package is installed and disappear when it is removed, and they show up in both the F1 reference and the `Ctrl+Shift+P` palette.

**Text tools package** (`Ctrl+Alt+letter`)

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+U` / `Ctrl+Alt+L` | To upper case / to lower case |
| `Ctrl+Alt+T` | Title case |
| `Ctrl+Alt+A` / `Ctrl+Alt+D` | Sort lines ascending / descending |
| `Ctrl+Alt+E` / `Ctrl+Alt+X` | Remove duplicate lines / remove empty lines |
| `Ctrl+Alt+R` | Reverse line order |
| `Ctrl+Alt+B` / `Ctrl+Alt+Shift+B` | Base64 encode / decode |
| `Ctrl+Alt+Q` | URL encode |
| `Ctrl+Alt+F` | Format JSON |
| `Ctrl+Alt+M` | Align columns by delimiter |

**Markdown tools package**

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+G` | Normalize table alignment |
| `Ctrl+Alt+O` | Generate a table of contents |
| `Ctrl+Alt+N` | Insert a footnote |
| `Ctrl+Alt+W` | Word count and reading time |

**Developer tools package** (`Ctrl+Alt+Shift+letter`)

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+Shift+R` | Regex match trainer |
| `Ctrl+Alt+Shift+E` | Escape a JSON string |
| `Ctrl+Alt+Shift+M` | MIME type lookup |
| `Ctrl+Alt+Shift+S` | Sort code lines |

**Community packages in the marketplace** (example packages; bindings are declared in their manifests too)

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+Shift+C` | CSV to a JSON array |
| `Ctrl+Alt+Shift+P` / `Ctrl+Alt+Shift+U` | Format JSON with 2 spaces / minify to one line |
| `Ctrl+Alt+Shift+J` | Generate a Schema from the selected JSON |
| `Ctrl+Alt+Shift+D` / `Ctrl+Alt+Shift+N` / `Ctrl+Alt+Shift+L` / `Ctrl+Alt+Shift+X` | Sort by leading number / natural order / line length; remove adjacent duplicates |

Convention: plugin bindings always live in the `Ctrl+Alt` family (`⌘+Option` on macOS) and never take a built-in main binding such as `Ctrl+S` or `Ctrl+F`. If a third-party package does declare a collision, the host drops that key and logs it to the console; the command itself stays available from the command palette.

The **Theme** menu at the top has four entries: **Ivory Light** (default), **Aurora Dark**, **Nord**, and **Solarized Light**. Switching themes also switches the syntax highlighting palette in the editor.

## 10. FAQ

### Double-clicking the exe does nothing?

Make sure the environment variable `ELECTRON_RUN_AS_NODE=1` is not set (a development machine here once had it, which makes Electron start as plain Node and never open a window). Clear the variable and try again.

### Can the installer and portable builds coexist?

Yes. Installer data lives in `%APPDATA%\QuillPad`, portable data in `QuillPad-Data\` next to the exe, and the two do not interfere.

### Commands from a disabled plugin still show up in the palette?

Disabling genuinely unregisters the commands in the `plugin.<id>.<cmd>` namespace and removes them from the command palette, menu bar, and toolbar at the same time; re-enabling restores them. A plugin that was disabled automatically after crashing has to be enabled by hand.
