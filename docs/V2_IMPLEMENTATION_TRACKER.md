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

## Priority 6 — Abkrino design system
- [ ] Apply a coherent Claymorphism design system across all screens (not a separate "Design" tab).
- [ ] Use Abkrino identity from installer through application, including a custom app icon.
- [ ] Improve installer branding.
- [ ] Keep animations lightweight and preserve responsiveness.
- [ ] Remove restrictive content-width constraints so each tab uses available workspace width.

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
