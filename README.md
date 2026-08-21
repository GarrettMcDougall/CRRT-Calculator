# CRRT: Prescribe & Learn

A static, no-build-step web app: a CRRT calculator (regional citrate and systemic heparin), a guided teaching mode, and a high-yield theory reference. Built for GitHub Pages.

**This is an educational tool. It is not a medical order.** Every solution concentration, titration table, and target range must be verified against your own unit's approved CRRT protocol and pharmacy monographs before this is used for anything beyond personal study.

## Deploying on GitHub Pages

1. Push this repository to GitHub.
2. Repo Settings → Pages → Deploy from branch → select `main` (or your default branch) and `/ (root)`.
3. Your site will be live at `https://<username>.github.io/<repo>/`.

No build step, no npm install: plain HTML/CSS/JS.

The app includes a service worker. Every online launch checks GitHub Pages for a newer deployment and uses network-first requests for app files. A new version activates immediately and reloads the app once. The most recently loaded version remains available offline.

For updates to reach users, replace the files in the same GitHub Pages repository and wait for the Pages deployment to finish. Users do not need to reinstall the home-screen app.

**Do not open `index.html` by double-clicking it.** The app loads its theory, cases, quiz, and config content with `fetch()`, and browsers block `fetch()` from a page opened directly off disk (`file://...`), so you'll get a "Something went wrong loading this view" error on the Learn and Theory tabs (Prescribe still loads because it degrades gracefully if the config can't be reached, but you're missing your local protocol values at that point too).

To preview locally, serve the folder over http instead, from inside `crrt-app/`:

```
python3 -m http.server 8000
```

then open `http://localhost:8000`. (`npx serve` works too, or any static file server / your editor's "Live Server" extension.) Once it's pushed to GitHub Pages this isn't an issue: Pages always serves over https.

## Forking for your own unit

Before using this beyond personal study:

1. Open `config/local-protocol.json`. Every value in it is a generic placeholder. Replace:
   - Dose targets
   - Citrate solution presets (concentrations vary by product and by site: do not trust the shipped values)
   - The calcium and heparin titration tables: these are placeholder structures, not real nomograms
   - Monitoring lab schedule and pressure limits
2. Review `data/solutions.json` with pharmacy and the CRRT program lead. It contains a brand-first product catalogue. Entries whose full composition is not yet verified appear in the menu but are disabled. Confirm regional availability, final bag-label composition, compatible connectors, and machine-integrated citrate/calcium workflows before enabling or adding products.
3. Set `"reviewed": true` at the top level once you've done this, and update the per-section `reviewed` flags in `data/theory.json`, `data/cases.json`, `data/quiz.json`, `data/solutions.json`, and `config/local-protocol.json` as you check each one. The app surfaces an "unreviewed content" marker until you do.
4. Re-run `tests/tests.html` in a browser after any change to `js/calc.js`. It checks dose, filtration fraction, citrate, heparin, electrolyte warnings, and guided starting-flow calculations.

See `CLINICAL_REVIEW.md` for corrected errors, unresolved local protocol decisions, and the recommended next build.

## Structure

- `js/calc.js`: pure calculation functions, no DOM. This is the part that has to be right; everything else is presentation.
- `tests/tests.html`: open directly in a browser to run the test suite and see pass/fail.
- `config/local-protocol.json`: the file you fork and edit for your site.
- `data/solutions.json`: region- and brand-grouped dialysate, replacement, and citrate catalogue with normalized mmol/L values and verification status.
- `data/*.json`: theory content, teaching cases, quiz bank, troubleshooting scenarios.

## Privacy

No patient identifiers are collected anywhere in this app. `localStorage` is used only for UI preferences (theme) and teaching-mode progress (which cases you've completed, quiz score), never for any clinical input you type into the calculators. Refresh the page and every calculator field resets; nothing about a specific patient is ever saved.

## License

Code: MIT. Educational content (`data/*.json`, theory text): CC BY-NC-SA 4.0. See `LICENSE`.
