Balmoral Swim Pace Tracker - All Swimmers
This version automatically discovers swimmer names from the Balmoral series results tables and allows comparisons against the configured base swimmer.
Key config
`data/config.json`:
```json
{
  "primarySwimmer": "Bennett, Emma",
  "trackAllSwimmers": true,
  "swimmers": []
}
```
`primarySwimmer` is the swimmer shown by default.
`trackAllSwimmers: true` tells the scraper to discover all swimmers from the results table.
Leave `swimmers` empty unless you want to manually restrict the list.
Update
Run Actions → Update Balmoral swim results → Run workflow.
