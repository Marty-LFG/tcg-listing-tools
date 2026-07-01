# Run TCG Listing Tools at Windows startup (LAN access)

Documentation here assumes **Command Prompt** (`cmd.exe`), not PowerShell. Paths use `C:\_dev\tcg-listing-tools`; change them if your clone lives elsewhere.

The Vite dev server listens on **0.0.0.0:5273**, so other devices on your network can use `http://<this-PC-ip>:5273`.

## One-time prep: Node.js + pnpm

1. **Node.js** — install the LTS build from https://nodejs.org/ if `node` is not on your PATH. Verify in **Command Prompt**:

   ```bat
   where node
   node --version
   ```

   For NSSM below, note the full path (often `C:\Program Files\nodejs\node.exe`).

2. **pnpm** — enable via Corepack (bundled with Node 16.13+):

   ```bat
   corepack enable
   corepack prepare pnpm@latest --activate
   pnpm --version
   ```

   If `corepack` is not found, install pnpm globally instead:

   ```bat
   npm install -g pnpm
   ```

3. **Install project dependencies**:

   ```bat
   cd /d C:\_dev\tcg-listing-tools
   pnpm install
   ```

   On pnpm 10+, if Vite fails to start, approve the esbuild postinstall script:

   ```bat
   pnpm approve-builds esbuild
   pnpm install
   ```

4. **Configure `.env`** — copy the example and add your API keys:

   ```bat
   copy .env.example .env
   notepad .env
   ```

   All API keys are optional — the suite runs keyless (see `.env.example`). Scrydex adds live
   Riftbound market pricing + a trend graph (Riftbound also works keyless via Riftscribe + eBay
   comps); the graded-card inventory tool can auto-fill from a PSA cert number if you set the
   optional `PSA_API_TOKEN`. Add the eBay / LEGO / PriceCharting / printer keys to unlock those
   features.

5. **Windows Defender Firewall** — allow inbound TCP **5273** on the profile you use (Private is typical at home). From an **elevated** Command Prompt (Run as administrator):

   ```bat
   netsh advfirewall firewall add rule name="TCG Listing Tools" dir=in action=allow protocol=TCP localport=5273 profile=private
   ```

   To allow on **all** profiles, omit `profile=private` or use `profile=any`.

## Run manually (test)

Double-click **`scripts\start-tcg-tools.cmd`** or from Command Prompt:

```bat
C:\_dev\tcg-listing-tools\scripts\start-tcg-tools.cmd
```

Or with pnpm directly:

```bat
cd /d C:\_dev\tcg-listing-tools
pnpm dev
```

Or invoke the launcher directly:

```bat
cd /d C:\_dev\tcg-listing-tools
node scripts\run-dev.mjs
```

Stop with Ctrl+C in that window. Open http://localhost:5273 from this PC, or `http://<this-pc-ip>:5273` from another device on the LAN.

## Install as a Windows service (NSSM)

Windows does not ship a simple “run this script as a service” tool. **[NSSM](https://nssm.cc/)** (Non-Sucking Service Manager) is a small, common choice.

1. Download NSSM from https://nssm.cc/download (pick **win64** on 64-bit Windows).

2. Unzip and open **Command Prompt as Administrator** (add NSSM’s `win64` folder to PATH for that session, or `cd` to it).

3. Install the service:

   ```bat
   nssm install TCGListingTools "C:\Program Files\nodejs\node.exe" "C:\_dev\tcg-listing-tools\scripts\run-dev.mjs"
   ```

4. In the NSSM GUI that opens:

   - **Startup directory**: `C:\_dev\tcg-listing-tools`
   - **Details** tab: Display name e.g. `TCG Listing Tools`, description optional.
   - **I/O** tab (optional): set **Output (stdout)** and **Error (stderr)** to log files, e.g. `C:\_dev\tcg-listing-tools\logs\service-out.log` and `service-err.log` (create the `logs` folder first).
   - **Exit actions** tab: restart on failure if you want automatic recovery.

5. If `node` is not under `C:\Program Files\nodejs\`, set **Application** to the path printed by:

   ```bat
   where node
   ```

6. Optional: hide extra console windows for child processes — on the **Environment** tab add:

   - `TCG_TOOLS_SERVICE` = `1`

7. **Service log on**: on the **Log on** tab, choose **Local System** (default) or an account that can read `.env` in the project folder. Network drives mapped only for your user may not be available to **Local System**; use your user account + “Log on as a service” right if needed.

8. Start the service:

   ```bat
   nssm start TCGListingTools
   ```

   Or: `services.msc` → **TCG Listing Tools** → Start.

9. Set start type to **Automatic** in `services.msc` (or `nssm set TCGListingTools Start SERVICE_AUTO_START` per NSSM docs).

To remove the service later:

```bat
nssm stop TCGListingTools
nssm remove TCGListingTools confirm
```

## Alternative: Task Scheduler (not a true service)

If you prefer not to use NSSM:

1. Open **Task Scheduler** → **Create Task**.

2. **General**: name `TCG Listing Tools`, select **Run whether user is logged on or not**, **Run with highest privileges** only if needed.

3. **Triggers**: **At startup** (or **At log on**).

4. **Actions**: **Start a program**

   - **Program/script**: `C:\_dev\tcg-listing-tools\scripts\start-tcg-tools.cmd`
   - **Start in** (optional): `C:\_dev\tcg-listing-tools\scripts`

   Or run Node directly:

   - **Program/script**: `C:\Program Files\nodejs\node.exe`
   - **Add arguments**: `C:\_dev\tcg-listing-tools\scripts\run-dev.mjs`
   - **Start in**: `C:\_dev\tcg-listing-tools`

5. **Conditions**: uncheck “Start only on AC power” if this is a laptop on battery.

6. **Settings**: optionally “If task fails, restart every…”.

Note: the task runs in Session 0 when “whether user is logged on or not”; behavior differs slightly from an interactive login. NSSM is usually simpler for a long-running dev server.

## Daily price analysis (Claude)

The price tracker collects prices automatically inside the running service (an in-process
timer — **no separate task needed**). What *is* scheduled separately is the daily **Claude
analysis** that reads the cached data, researches market trends, flags opportunities/
downtrends, auto-adds promising cards for review, writes a digest to `reports\`, and fires
desktop toasts.

**Prerequisites**

- The TCG Listing Tools service (above) is running — the analysis reads `http://127.0.0.1:5273/api/tracker/...`.
- The **Claude CLI** is installed and **pre-authenticated for the logged-on user** (run `claude` once interactively, or set an API key in that user profile). Headless runs can't complete a login prompt.

**Schedule it**

1. Open **Task Scheduler** → **Create Task**.
2. **General**: name `TCG Price Analysis`; select **Run only when user is logged on** — this is required so the desktop **toast notifications render** (WinRT toasts need an interactive session; the service itself can run headless under NSSM, but this task can't).
3. **Triggers**: **Daily**, e.g. **07:30** (after the overnight collector pass).
4. **Actions**: **Start a program**
   - **Program/script**: `C:\_dev\tcg-listing-tools\scripts\run-claude-analysis.cmd`
   - **Start in**: `C:\_dev\tcg-listing-tools`
5. **Conditions**: uncheck "Start only on AC power" if on a laptop.
6. **Settings**: optionally "Stop the task if it runs longer than 1 hour".

Output is logged to `logs\claude-analysis-YYYYMMDD.log`. To test now, just run
`scripts\run-claude-analysis.cmd` from Command Prompt while logged in. Tune the cadence and
signal thresholds in `data\tracker.config.json`; tune what Claude does in
`.claude\skills\price-analyst\SKILL.md`.

## Production note

This setup runs the **Vite dev server** (`pnpm dev` equivalent). Fine for a trusted home LAN; do **not** expose it to the public internet. A production static build would need a backend that re-implements the API proxies (see `AGENTS.md` Golden Rule 1).
