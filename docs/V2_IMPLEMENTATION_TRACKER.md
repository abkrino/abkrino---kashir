# Abkrino Kashir V2 — Implementation Tracker

**Working branch:** `v2/review-and-stabilization`  
**Baseline commit audited:** `8259ef848c7c6a511c40779fe33db7ba51319bb4`  
**Status:** In progress — audit findings are not equivalent to completed implementation.

## Guardrails
- Work only on `v2/review-and-stabilization`.
- Never modify `main`.
- Do not merge PR #1 or any PR.
- Do not publish a release without explicit owner approval.
- Do not access or modify `abkrino/media-saas`.
- Preserve user backups; test restore using isolated copies.
- Mark an item complete only after implementation, automated tests, and relevant Windows/device validation are evidenced.

## Priority 0 — Critical reliability
- [ ] Backup restore: reproduce the SHA-256 mismatch with a preserved source backup; identify whether canonicalization, serialization, encoding, or transfer changes bytes; add regression tests.
- [ ] Cloud backup upload: trace the exact bytes hashed, uploaded, downloaded, and validated; verify end-to-end integrity without bypassing checksum validation.
- [ ] Voice announcer: verify Windows TTS on a real Windows device, Arabic voice discovery, fallback messaging, WAV generation/playback, and PowerShell CLIXML handling.
- [ ] Cashier responsiveness: profile realistic product and invoice data; record before/after timings.
- [ ] Inventory responsiveness: benchmark 2,000+ products and evaluate pagination/virtualization.

### Backup SHA-256 investigation — current findings
- The local export hashes the business-data object using `computeDataChecksum`; file validation parses JSON and hashes the parsed `data` object again.
- Cloud upload stores two distinct digests: an inner business-data checksum and an outer SHA-256 over the exact Base64 transport string. Download validates the outer digest before decompression, then validates the inner package digest.
- The cloud path currently permits a legacy inner-checksum mismatch only after the exact downloaded transport payload has independently passed SHA-256. This is a compatibility path, not proof that the local file restore mismatch is fixed.
- Existing local checksum coverage primarily validates the generated package object. A new regression suite was added to test the actual JSON file round-trip and tamper rejection: `src/services/backupChecksumRoundTrip.test.ts`.
- New test commit: `8e35b15ee5b08ea43cb7e60c9433558d5f8b0e6f`. No CI status is available for this commit yet; the tests are **not** marked passed.
- Root cause of the owner's original backup mismatch remains unproven until the exact original backup file is available for isolated inspection. Do not weaken checksum validation or modify the original file.

## Priority 1 — Inventory, sales, purchasing
- [ ] Enforce no sale beyond available stock at UI and storage/service boundaries, including invoice edits and concurrent operations.
- [ ] Permit a negative cash drawer only for explicitly authorized users; never interpret this as permission for negative inventory.
- [ ] Design and implement lot-level FIFO: received quantity, remaining quantity, unit cost, received timestamp, and persisted allocations for sales/returns/adjustments.
- [ ] Define a safe opening-stock migration policy; do not invent historical lot dates or costs.
- [ ] Validate purchase, return, adjustment, and deletion accounting against lot allocations.

## Priority 2 — Product categories
- [ ] Recover and reconcile the owner's original category list before changing it.
- [ ] Identify exact duplicates versus legitimate distinct categories; preserve useful original names.
- [ ] Add missing grocery/cleaning categories only after review.
- [ ] Implement category create/edit and safe deletion with product-reference checks.

## Priority 3 — Companies and suppliers
- [ ] Add an "Add as supplier" action to each company entry, creating a supplier named after that company.
- [ ] Support later completion of representative, phone, address, and payment terms.
- [ ] Rename supplier action "سند صرف" to "إضافة دفعة" where applicable.

## Priority 4 — Human Resources
- [ ] Add employee profiles and per-employee QR identifiers.
- [ ] Design attendance validation to prevent proxy check-ins; QR alone is not identity proof.
- [ ] Configure shifts, work hours, lateness, deductions, overtime rates, payroll, bonuses, advances, and employee statements.
- [ ] Add attendance and payroll reports.

## Priority 5 — Permissions and dashboard
- [ ] Expand permissions to granular view/add/edit/delete/print/export controls.
- [ ] Add per-employee permissions, including shifts, inventory, accounting, and HR.
- [ ] Add dashboard indicators for sales, inventory, profits, and employees.

## Priority 6 — Abkrino visual identity and complete Claymorphism design system

### Brand assets — immutable source of truth
- [ ] Locate and verify the original `logo.jpg` and `icon_2.png` assets in the repository or owner-provided project assets before implementation. The previous code search did not confirm their repository paths; do not recreate or approximate either asset.
- [ ] Preserve the exact ABKRINO wordmark, the exact tagline `SEARCH, DEVELOP, RUN`, and the original mascot/logo composition, shapes, text, and spatial proportions from `logo.jpg`.
- [ ] Use `icon_2.png` as the exact application/file icon. Preserve its geometry, spiky hair, circular glasses, teal eyes and offset pupils, central nose/mouth line, three lower prongs, colors, and proportions.
- [ ] Apply clay-like surface treatment only to surrounding UI surfaces; never redraw, simplify, distort, recolor, crop, or alter the source logo or mascot artwork.
- [ ] Do not misspell ABKRINO or modify the tagline. Avoid cyberpunk neon edges and heavy/grungy visual clutter.

### Branding must start at installation — not only after the app opens
- [ ] Apply ABKRINO branding to the Windows installer experience from its first visible screen: installer icon, wizard/window identity, header or welcome artwork where supported, progress/completion screens, and shortcuts.
- [ ] Use the exact `icon_2.png` for the installer executable/file icon, installed application icon, taskbar/window icon, desktop shortcut, and Start Menu shortcut. Confirm Windows displays the intended icon after installation.
- [ ] Use the full `logo.jpg` wordmark/tagline in installer artwork only where it can be shown without distortion or illegible scaling.
- [ ] Carry the same brand identity through first launch, login/loading states, app title/header, navigation, all modules, dialogs, and relevant empty/error states.
- [ ] Ensure the uninstaller and Windows app metadata use the ABKRINO POS product name and consistent branding where the installer technology permits.
- [ ] Build and inspect the actual Windows installer on Windows; a branded in-app screen alone does not satisfy this requirement.

### Global visual language
- [ ] Apply Claymorphism consistently across the entire application: soft tactile 3D clay surfaces, puffy rounded controls, clean uncluttered composition, and a friendly modern POS feel without sacrificing cashier speed or readability.
- [ ] Use soft diffused top-left studio lighting; subtle top-left inset/highlight bevels; gentle bottom-right inner shadows; soft ambient outer shadows; minimal harsh outlines.
- [ ] Standard radii: pill buttons `999px`; large cards `32px`; medium cards `24px`; buttons/inputs `16px`; icon containers `24px`.
- [ ] Use the specified clay elevation/inset shadow language as design references, adapting opacity to maintain readable contrast and avoid muddy or overly embossed text.
- [ ] Use a clean geometric UI font with Arabic and English support (Cairo, Tajawal, or IBM Plex Sans Arabic for Arabic; Inter or Plus Jakarta Sans for English/numerals).
- [ ] Use tabular lining numerals for prices, totals, quantities, barcodes, and receipt amounts.
- [ ] Keep motion subtle and lightweight; respect reduced-motion/accessibility preferences and avoid delaying cashier actions.

### Light theme palette and component behavior
- [ ] Main background `#F0F4F8`; card `#FFFFFF`; secondary surface `#E8EEF5`.
- [ ] Primary teal `#00897B`; light teal `#26A69A`; secondary green `#16A34A`.
- [ ] Accent crimson `#8E241C`; dark brand crimson `#5A120E`; accent yellow `#FBBF24`.
- [ ] Primary text `#1E242B`; secondary text `#5A6572`; subtle border `rgba(0,0,0,0.05)`.
- [ ] Header uses card surface and clay elevation; preserve the logo artwork while applying teal only to surrounding brand accents.
- [ ] Product cards use white clay surfaces and green add buttons.
- [ ] Checkout panel uses the secondary surface with an inset clay treatment.
- [ ] Pay action uses crimson with white text; save/print action uses green with white text.
- [ ] Active sidebar item uses teal with white text and a subtle inset treatment.

### Dark theme palette and component behavior
- [ ] Main background `#15151F`; card `#1D1D28`; secondary surface `#181822`.
- [ ] Teal glow `#00C8B3`; green glow `#22C55E`; dark crimson `#B91C1C`; yellow glow `#FDE047`.
- [ ] Primary text `#F3F4F6`; secondary text `#9CA3AF`; subtle border `rgba(255,255,255,0.05)`.
- [ ] Header uses card surface and a restrained dark shadow; preserve source logo colors/artwork.
- [ ] Product cards use dark card surfaces and green add buttons.
- [ ] Checkout panel uses `#181822` with a subtle inset shadow.
- [ ] Pay action uses dark crimson with white text; save/print uses green with dark text.
- [ ] Active sidebar item uses glowing teal with dark text and a subtle inset treatment.
- [ ] Ensure glow is restrained and never harms text contrast or causes visual noise.

### POS-specific interaction and layout rules
- [ ] Product cards: clear title, price badge, soft clay surface, and tactile press feedback.
- [ ] Category tabs: rounded pill controls; active category uses brand teal elevation, inactive categories remain visually quiet.
- [ ] Cart/checkout: clearly itemized lines, subtotal, discount/tax breakdown, and prominent pay/save/print actions; checkout panel may use inset clay treatment.
- [ ] Numpad and quick actions: large finger-friendly keys with clear pressed states for fast cash entry.
- [ ] Top bar: exact mascot icon and/or undistorted full logo, branch/shift status, search, and quick actions.
- [ ] Maintain high information density where needed for cashier work; clay styling must not reduce scan speed, hit targets, or numeric legibility.
- [ ] Remove restrictive fixed/max content-width wrappers so every tab uses the available application workspace while retaining sensible responsive gutters.

### Design acceptance criteria
- [ ] A visual review confirms installer → first launch → login → dashboard → cashier → inventory → suppliers → HR → reports → settings all share one coherent system.
- [ ] Both light and dark themes are checked for contrast, Arabic shaping, English labels, numeric alignment, focus/hover/pressed/disabled/error states.
- [ ] Exact source assets are visually compared against installer, app icon, and in-app logo outputs; no redraw or distortion is accepted.
- [ ] Test at the supported minimum window size and common Windows display scaling settings; verify no clipped controls or unusable cashier layout.
- [ ] Performance check confirms shadows/animations do not materially slow the cashier or inventory screens.

## Verification / release gates
- [ ] Type check and automated tests pass.
- [ ] Windows installer build succeeds and artifact is retrievable.
- [ ] Backup restore and cloud round-trip pass using test copies.
- [ ] Voice announcer passes on the target Windows machine with Arabic TTS or a clear supported fallback.
- [ ] Performance benchmarks are recorded for 2,000+ products.
- [ ] HR, permissions, FIFO, and migration scenarios have dedicated tests.
- [ ] Owner reviews the candidate build before any merge or release.

## Current known evidence (baseline audit; re-verify after code changes)
- CI run `45147745735`: type check passed; 166 tests passed, 7 skipped; installer build succeeded.
- Firestore rules tests were skipped; Windows device smoke tests are still required.
- Installer was unsigned (no code-signing certificate configured).
- Existing backup checksum tests passing does not prove restoration of the owner's original backup.
- Existing batch/expiry fields do not constitute lot-level FIFO.
- HR module was not present in the audited baseline.

### Voice announcer decision update — offline-only, Egyptian Arabic
- Owner explicitly requires speech generation to work **without internet at runtime**. Azure/cloud TTS is rejected for this product requirement; never send announcement text to a remote provider.
- Best current candidate for an Egyptian voice is **VoiceTut-TTS** (Egyptian-Arabic fine-tune, language id `arz`, 19 built-in voices, Egyptian text normalization, Apache-2.0 model card). Its published benchmark reports 2.93 GB peak VRAM on an NVIDIA T4 for fp16; do not assume this is fast or viable on CPU or every cashier PC. Sources: model card and upstream repository.
- Proposed proof-of-concept target: package VoiceTut + its OmniVoice dependencies and one selected built-in voice, run synthesis in a local child process/service, and save WAV files into the existing local announcements playlist. Download/model setup happens at build or installer packaging time; after installation, text-to-speech, playback, and playlist must function with network disconnected.
- Hardware gate: test on the actual supported cashier hardware, including CPU-only fallback if no supported NVIDIA GPU is present. The owner's separate development PC has an RTX 3050 6 GB, but this is not evidence that every customer POS machine has a GPU. Benchmark cold start, warm synthesis time for a 10–20 second Egyptian offer, peak RAM/VRAM, installer size, and app responsiveness.
- Voice quality gate: test Egyptian shop phrases, prices, quantities, discounts, brand/product names, and Arabic-English mixed words using the 19 built-in speakers; choose one default only after listening and owner approval. No voice cloning by default.
- Licensing gate: preserve Apache-2.0 notices for VoiceTut, audit OmniVoice, Qwen backbone, tokenizer/vocoder, model weights, reference clips, and every runtime dependency before redistributing the complete bundle. A model-card license alone does not automatically clear every dependency.
- Keep a no-network fallback: allow importing an externally recorded WAV/MP3 announcement into the same playlist. If neural TTS is too slow on CPU or package size is unacceptable, this remains available without internet.
- Current status: **research candidate only**. No VoiceTut runtime/model has been added to the repository; do not claim offline speech generation is implemented or verified.
- Acceptance: install from the complete offline installer on a clean Windows machine, disable Wi-Fi/Ethernet, generate an Egyptian Arabic WAV, restart the app, play the saved announcement, and confirm the playlist persists. Test missing/corrupt model errors and ensure cashier operations remain responsive.
