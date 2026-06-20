# Balmoral Swimmer Comparison Tracker

This is a GitHub Pages app for tracking Balmoral Beach Club swim pace results and comparing multiple swimmers.

## Files

- `index.html` — dashboard and chart.
- `data/config.json` — swimmer list and race series configuration.
- `data/results.json` — generated result data used by the dashboard.
- `scripts/scrape-balmoral.js` — scraper run by GitHub Actions.
- `.github/workflows/update-results.yml` — scheduled/manual update workflow.

## Setup from scratch

1. Create a new GitHub repository.
2. Upload the contents of this folder to the repository root.
3. Ensure the repository root contains:
   - `.github/`
   - `data/`
   - `scripts/`
   - `index.html`
   - `package.json`
   - `README.md`
4. Go to **Settings → Pages**.
5. Set **Source** to **Deploy from a branch**.
6. Select branch `main` and folder `/root`.
7. Go to **Actions → Update Balmoral swim results → Run workflow**.
8. Wait for the action to complete, then refresh the GitHub Pages site.

## Add swimmers

Edit `data/config.json` and update the swimmer list. Use the exact Balmoral format:

```json
"swimmers": [
  "Bennett, Emma",
  "Bennett, Shaun"
]
```

## Notes

- The workflow uses Node 24 and does not enable npm caching, so no `package-lock.json` is required.
- The scraper has a safer date parser to avoid the previous `RangeError: Invalid time value` issue.
- If the Balmoral table format changes, the workflow may still complete with warnings shown in the dashboard.
